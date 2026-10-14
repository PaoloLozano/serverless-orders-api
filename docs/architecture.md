# Architecture & design decisions

This document explains the design choices behind the API: what was chosen, why, and what the alternatives would cost. It has three main parts:

1. [Data model: partition key and sort key](#1-data-model-partition-key-and-sort-key)
2. [Caching: the cache-aside pattern](#2-caching-the-cache-aside-pattern)
3. [Infrastructure as code with AWS SAM](#3-infrastructure-as-code-with-aws-sam)

It then covers [error handling](#4-correctness-and-error-handling), [security](#5-security), [testing](#6-testing-strategy) and [next steps](#7-trade-offs-and-next-steps).

---

## 1. Data model: partition key and sort key

### Start from the access patterns

In DynamoDB you design the keys around the queries, not around the entities. This API needs:

| #   | Access pattern                                    | Frequency |
| --- | ------------------------------------------------- | --------- |
| 1   | Get one order                                     | very high |
| 2   | List a customer's orders, newest first, paginated | high      |
| 3   | Same, restricted to a date range                  | medium    |
| 4   | Create an order                                   | medium    |
| 5   | Change an order's status (with valid transitions) | medium    |

### The two keys

DynamoDB's primary key here is **composite**: a partition key plus a sort key. Together they must be unique.

- **Partition key (`PK`, `KeyType: HASH`)** decides _where_ an item is stored. DynamoDB hashes the value and uses the hash to choose a physical partition. All items with the same partition key form an **item collection** and are stored together.
- **Sort key (`SK`, `KeyType: RANGE`)** decides the _order_ of items inside that collection. Because the items are kept sorted, you can run range conditions (`=`, `<`, `>`, `BETWEEN`, `begins_with`) on the sort key, and read in ascending or descending order.

The design:

```
PK = CUSTOMER#<customerId>      SK = ORDER#<orderId as ULID>
```

How each access pattern uses those keys:

- **Pattern 1** is a `GetItem` with both keys. It is the cheapest and fastest read DynamoDB has.
- **Pattern 2** is a `Query` on `PK = CUSTOMER#c-123 AND begins_with(SK, 'ORDER#')` with `ScanIndexForward = false`. It reads one item collection, newest first. `Limit` combined with `LastEvaluatedKey` gives pagination.
- **Pattern 3** is the same `Query` with `SK BETWEEN :start AND :end`, using the bounds described in the next section.
- **Pattern 5** is a single conditional `UpdateItem`.

None of them needs a `Scan` or a secondary index.

### Why `customerId` as the partition key

- **High cardinality.** There are many distinct customers, so traffic and storage spread evenly across partitions. One physical partition serves at most about 3,000 RCU and 1,000 WCU per second, so you want many distinct partition key values.
- **It matches the main query.** "Orders of a customer" becomes one `Query`.
- **Natural isolation.** With authentication in place, `customerId` would come from the token. Every query would then be confined to the caller's own partition.

A partition key with **low cardinality**, such as `status` or the date, would send every request to a few values and create _hot partitions_. That is why "list orders by status" is not modelled with `status` as a key (see [next steps](#7-trade-offs-and-next-steps)).

### Why a ULID in the sort key

A ULID is 128 bits: a 48-bit millisecond timestamp followed by 80 random bits. It is encoded in Crockford base32, so the string sorts in the same order as the timestamp. Putting it in the sort key gives three things:

- **Uniqueness**, from the 80 random bits, without any coordination between Lambda instances.
- **Chronological order for free.** Sorting by `SK` is sorting by creation time.
- **Date-range queries on the key.** For a window `[from, to]`, the smallest possible ULID is `encodeTime(from) + "0000000000000000"` and the largest is `encodeTime(to) + "ZZZZZZZZZZZZZZZZ"`. Every order created in the window sorts between them (`orderSortKeyRange` in [`keys.ts`](../src/repositories/keys.ts)).

The service uses a **monotonic** ULID factory, so two orders created in the same millisecond by the same container still get increasing IDs.

Alternatives considered:

| Option                        | Problem                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `SK = ORDER#<uuid v4>`        | Random order, so no chronological listing. You would need a second index on `createdAt`.                           |
| `SK = ORDER#<createdAt>#<id>` | Sorts correctly, but then `GetItem` needs the timestamp too. The order ID alone would no longer identify the item. |
| `SK = ORDER#<ULID>` ✅        | One value is both the identifier and the sort order.                                                               |

### Key conditions vs filter expressions

`begins_with` and `BETWEEN` on the sort key are **key conditions**: DynamoDB reads only the matching items. A `FilterExpression` is applied _after_ the read, so you pay for every item read, including the ones it discards, and `Limit` counts items before the filter. The design keeps every predicate in the key condition.

### Prefixes and single-table design

`CUSTOMER#` and `ORDER#` make keys self-describing. They also allow new entity types in the same partition later, for example `SK = PROFILE` or `SK = ADDRESS#1`, and one `Query` could then fetch a customer together with their orders. For the same reason, IDs are validated against `^[A-Za-z0-9_-]{1,64}$`. An ID containing `#` could forge keys ("key injection").

### Other DynamoDB details

- **On-demand capacity** (`PAY_PER_REQUEST`): no capacity planning, and you pay per request. That is the right default until traffic is predictable.
- **Point-in-time recovery** is enabled. Encryption at rest is DynamoDB's default.
- `status` is a **reserved word** in DynamoDB expressions, so it is aliased as `#status`.
- `attribute_not_exists(PK)` on `PutItem` checks the item with _that exact primary key_ (PK + SK), not the whole partition. It guarantees that a create never overwrites an existing order.

---

## 2. Caching: the cache-aside pattern

### What cache-aside means

In **cache-aside** (also called _lazy loading_), the application talks to the cache and to the database itself. The cache sits _aside_ and never calls the database.

**Read path** (`OrderService.getOrder` in [`order-service.ts`](../src/services/order-service.ts)):

1. Read the key from the cache. On a **hit**, return it.
2. On a **miss**, read from DynamoDB, the source of truth.
3. Store the result in the cache with a **TTL** and return it.

**Write path** (`OrderService.updateOrderStatus`):

1. Write to DynamoDB.
2. **Delete** the cached key. The next read loads the fresh value.

Comparison with the other caching strategies:

| Strategy           | Who loads the cache                             | Trade-off                                                                                                                     |
| ------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Cache-aside** ✅ | The application, on a miss                      | Only data that is actually read gets cached. The app survives a cache outage. The first read after an invalidation is a miss. |
| Read-through       | The cache, on a miss                            | Simpler application code, but the cache must know how to reach the database (DAX does this).                                  |
| Write-through      | Every write updates cache and database          | The cache is always warm, but you also cache data nobody reads, and every write is slower.                                    |
| Write-behind       | The cache writes to the database asynchronously | Fast writes, but data can be lost if the cache fails.                                                                         |

### Why cache order reads at all?

`GetItem` is already fast (single-digit milliseconds). The cache earns its place when reads greatly outnumber writes. Order tracking is a good example: a customer refreshes an order page far more often than the order changes. In that case the cache:

- lowers DynamoDB read cost
- absorbs read spikes on popular items, which DynamoDB would otherwise handle as a hot key
- gives lower, more stable latency (sub-millisecond in-memory reads)

### Design details and why they matter

**Invalidate instead of updating the cache on writes.** Suppose two writers both run "update DB, then SET cache". They can interleave as: writer A updates the DB, writer B updates the DB, B sets the cache, A sets the cache. The cache now holds A's older value until the TTL expires. Deleting the key is idempotent and avoids that race: whichever delete runs last, the next read reloads the current value.

**Strongly consistent read on a miss** (`ConsistentRead: true`). DynamoDB reads are eventually consistent by default. If a request misses right after an update invalidated the key, an eventually consistent read could still return the _previous_ version, and that stale value would be re-cached for a full TTL. A strongly consistent read costs twice as much, but it only happens on misses.

**TTL on every entry, plus jitter.** The TTL is the safety net: whatever goes wrong (a failed invalidation, a write that bypassed the service), stale data lives at most one TTL (300 s by default). The TTL also gets up to +10% random jitter. Without it, keys cached at the same moment would all expire together and send a burst of misses to DynamoDB.

**Fail-open.** The cache is an optimisation, not a dependency. Every cache error is caught, logged and counted (`CacheError` metric), and the request continues against DynamoDB. The Redis client uses short timeouts (1 s to connect, 300 ms per command) so a sick cache cannot make the API slow. A corrupted entry is treated as a miss.

**Versioned keys:** `orders:v1:<customerId>:<orderId>`. If the cached JSON shape ever changes incompatibly, bumping `v1` to `v2` makes old entries unreachable at once (they expire on their own).

**No cache write on create.** This is pure cache-aside: the first read loads the entry. Writing on create would be write-through, and it would fill the cache with orders that may never be read.

**Lists are not cached.** A list has many key variations (limit, date range, pagination token), and every write would have to invalidate all of them. A single-partition `Query` is already efficient. Cache what is hot and easy to invalidate.

**Measured, not assumed.** `CacheHit` and `CacheMiss` metrics give the hit ratio in CloudWatch. That ratio tells you whether the cache is worth its cost and whether the TTL is right.

### A known race, and why it is acceptable

Cache-aside has a classic race:

1. Reader R misses and reads version 1 from the database.
2. Writer W writes version 2 and deletes the key.
3. R, delayed, writes version 1 to the cache.

R's stale version 1 then stays cached until the TTL. Three things make this rare:

- The window between R's read and R's write is a few milliseconds.
- The consistent read narrows it further.
- The TTL bounds the damage.

If that were unacceptable, the options would be: versioned writes (store `updatedAt` and refuse to overwrite a newer value, using a Lua script or `SET ... NX`), invalidation driven by **DynamoDB Streams**, or no caching of that data at all.

### Why ElastiCache Serverless with Valkey?

- **Valkey** is the open-source, Redis-compatible engine (a Linux Foundation fork of Redis), and AWS prices it below Redis OSS on ElastiCache. The code uses `ioredis`, so it works with Redis too.
- **Serverless** means no node sizing and no cluster management, and it scales automatically. `CacheUsageLimits` in the template caps storage and compute so the bill stays predictable. It always encrypts traffic in transit, which is why the client connects with TLS. It speaks the Redis Cluster protocol, so production uses the cluster client (`CACHE_CLUSTER_MODE=true`).

Alternatives:

| Option                            | Why not here                                                                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DAX** (DynamoDB Accelerator)    | Read-through/write-through for DynamoDB only, so it is not cache-aside. It is also node-based, and it does not let the application control what is cached or how it is invalidated. |
| **API Gateway caching**           | Only available on REST APIs (not HTTP APIs), works per URL, and gives no fine-grained invalidation from the write path.                                                             |
| **In-memory cache inside Lambda** | Each container has its own copy, so a write cannot invalidate the others. That is fine for static configuration, wrong for orders.                                                  |

---

## 3. Infrastructure as code with AWS SAM

### What SAM is

The **AWS Serverless Application Model** has two parts:

1. **A template language.** `template.yaml` is a CloudFormation template with `Transform: AWS::Serverless-2016-10-31`. That transform adds short resource types such as `AWS::Serverless::Function` and `AWS::Serverless::HttpApi`. At deploy time, CloudFormation expands each one into the underlying resources. For example, one `AWS::Serverless::Function` with an `HttpApi` event becomes a Lambda function, an IAM role, an API route, an integration and a Lambda permission.
2. **A CLI.** `sam build` compiles the code (here, TypeScript bundled by esbuild). `sam deploy` uploads the artifacts to S3 and creates or updates the CloudFormation stack through a change set. `sam local start-api` emulates API Gateway and Lambda in Docker, and `sam validate` lints the template.

Because it is CloudFormation underneath, everything that is not serverless (the VPC, security groups, ElastiCache, log groups) is declared in the same template with plain CloudFormation resources.

### What this template defines

| Section                         | What it does                                                                                                                                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Parameters` / `Conditions`     | `EnableCache` toggles the whole cache layer. Every VPC/ElastiCache resource has `Condition: CacheEnabled`, and the functions use `!If` to attach to the VPC only when it exists. `CacheTtlSeconds` and `LogRetentionInDays` are tunable.                       |
| `Globals`                       | Settings shared by all functions: Node.js 22 on **arm64** (Graviton is cheaper per GB-second than x86), memory, timeout, X-Ray tracing, common environment variables.                                                                                          |
| `OrdersApi`                     | An HTTP API with CORS, **throttling** (a rate limit and a burst limit that protect Lambda and DynamoDB) and JSON **access logs**.                                                                                                                              |
| 4 × `AWS::Serverless::Function` | One function per route. Each one gets only the permissions it needs, through **SAM policy templates** (`DynamoDBReadPolicy` or `DynamoDBWritePolicy`) scoped to the table. `Metadata.BuildMethod: esbuild` makes `sam build` bundle and minify the TypeScript. |
| `OrdersTable`                   | `PK` as `HASH` (partition key), `SK` as `RANGE` (sort key), on-demand billing, PITR.                                                                                                                                                                           |
| VPC resources                   | Two private subnets in two Availability Zones, a route table, a **DynamoDB gateway endpoint**, and two security groups. The cache group only accepts port 6379–6380 _from the Lambda security group_.                                                          |
| `Cache`                         | `AWS::ElastiCache::ServerlessCache` running Valkey 8, with usage limits.                                                                                                                                                                                       |
| Log groups                      | Explicit retention, so logs do not accumulate (and cost) forever.                                                                                                                                                                                              |
| `Outputs`                       | The API URL, table name and cache endpoint.                                                                                                                                                                                                                    |

### Why one function per route?

- **Least privilege.** The read functions cannot write.
- **Smaller blast radius.** Each function has its own logs, metrics, memory and timeout, and each can be tuned on its own.
- **Only the cache users join the VPC**, so create and list stay outside it.

The trade-off is more functions to manage and more cold starts. A single "Lambdalith" with a router has fewer cold starts but broader permissions.

### Why the VPC, and why no NAT Gateway?

ElastiCache is only reachable from inside a VPC, so the cache users must run in private subnets. Private subnets have no internet route, and DynamoDB is reached through a public endpoint. A NAT Gateway would fix that, but it is billed per hour plus per GB. A **gateway VPC endpoint** for DynamoDB is free and keeps the traffic on the AWS network.

### Deployment flow

```
sam build   → esbuild bundles src/handlers/*.ts into .aws-sam/build/<Function>/
sam deploy  → package to S3 → CloudFormation change set → review → execute
```

`samconfig.toml` stores the defaults (stack name, region, parameters), so `sam deploy` needs no flags. In CI, GitHub Actions assumes an IAM role through **OIDC** (short-lived credentials, no stored access keys) and runs the same commands.

---

## 4. Correctness and error handling

- **Atomic status transitions.** The allowed previous statuses are computed from the state machine (`allowedPreviousStatuses`) and sent as `ConditionExpression: attribute_exists(PK) AND #status IN (...)`. The database checks and writes in one step, so two concurrent requests cannot both "win". `ReturnValuesOnConditionCheckFailure: ALL_OLD` returns the current item when the check fails. That separates a 404 (no item) from a 409 (wrong status) without a second read.
- **Validation at the boundary** with zod: path parameters, query strings and bodies. Unknown fields are rejected, and prices and quantities must be integers.
- **One error mapper** (`httpHandler`). Domain errors carry their HTTP status and a stable code. Unexpected errors are logged with their stack trace, and clients get a generic `500` with no internal details.
- **Money as integer cents**, so floating-point errors cannot appear.

## 5. Security

- Least-privilege IAM per function, scoped to one table.
- The cache only accepts traffic from the Lambda security group, and in-transit encryption (TLS) is always on.
- IDs are validated against a strict allow-list, which prevents key injection.
- **Pagination tokens are untrusted input.** A token is the base64url-encoded `LastEvaluatedKey`. On decode, the service checks the token's shape _and_ that its `PK` matches the customer being queried. Without that check, a forged token could start the Query inside another customer's partition.
- API throttling limits abuse and runaway clients.
- **Not implemented (demo scope): authentication.** In production, add a **JWT authorizer** (Amazon Cognito) on the HTTP API and take `customerId` from the token's `sub` claim instead of the path.

## 6. Testing strategy

- **Unit tests** (`tests/unit`) cover the domain rules, key building, pagination tokens, configuration, HTTP mapping and the full cache-aside behaviour, using in-memory fakes:
  - hit, miss and population
  - TTL with jitter
  - fail-open on cache errors and on corrupted entries
  - invalidation order (database first, then cache)
  - no invalidation when the write fails
- **Integration tests** (`tests/integration`) call the real Lambda handlers against DynamoDB Local and Valkey. They check that the cache is actually populated and invalidated, that transitions are enforced by DynamoDB, and that pagination, date-range queries and forged tokens behave as designed.
- **Smoke test** (`npm run smoke`) runs against a deployed or `sam local` API.
- **CI** runs format check, lint, type-check, both test suites, `sam validate --lint` and `sam build` on every push and pull request.

## 7. Trade-offs and next steps

| Idea                                 | Why / how                                                                                                                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication                       | Cognito JWT authorizer, with `customerId` taken from the token.                                                                                                                         |
| Get order by ID without the customer | Add a GSI with `GSI1PK = ORDER#<orderId>`. GSI reads are eventually consistent, so do not populate the cache from them.                                                                 |
| List orders by status (back-office)  | A GSI keyed on `status` alone would be hot. Use a **sharded** key such as `STATUS#PAID#<0-9>` and query the shards in parallel, or a sparse GSI that only contains open orders.         |
| Idempotent `POST`                    | Accept an `Idempotency-Key` header and store results with Powertools Idempotency (DynamoDB-backed), so client retries cannot create duplicate orders.                                   |
| Events                               | Enable DynamoDB Streams and publish `OrderStatusChanged` to EventBridge. The same stream could drive cache invalidation.                                                                |
| Cache penetration                    | Cache short-lived "not found" markers so repeated requests for non-existent IDs do not reach DynamoDB.                                                                                  |
| Signed pagination tokens             | HMAC-sign or encrypt the tokens so clients cannot even read the key format.                                                                                                             |
| Alarms                               | CloudWatch alarms on 5xx rate, p99 latency, throttles and a falling cache hit ratio.                                                                                                    |
| Cold starts                          | Measure first. Then consider Provisioned Concurrency on the hot read path, and leaving the AWS SDK out of the bundle (`External: ['@aws-sdk/*']`) because the runtime already ships it. |
| Tighter IAM                          | SAM's `DynamoDBReadPolicy` also grants `Scan` and `BatchGetItem`. An inline policy with only `GetItem`/`Query` would be stricter.                                                       |

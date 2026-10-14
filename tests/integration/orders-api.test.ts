/**
 * Integration tests: real Lambda handlers against DynamoDB Local and Valkey.
 * Start the dependencies first:  npm run local:up
 */
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { Redis } from 'ioredis';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ordersTableDefinition } from '../../scripts/table-definition';
import { getDependencies, setDependencies } from '../../src/container';
import type { Order } from '../../src/domain/order';
import { handler as createOrder } from '../../src/handlers/create-order';
import { handler as getOrder } from '../../src/handlers/get-order';
import { handler as listOrders } from '../../src/handlers/list-orders';
import { handler as updateOrderStatus } from '../../src/handlers/update-order-status';
import type { LambdaHttpHandler } from '../../src/lib/http';
import { DynamoDbOrderRepository } from '../../src/repositories/dynamodb-order-repository';
import { orderCacheKey } from '../../src/services/order-service';
import { httpEvent, lambdaContext } from '../support/http-events';

const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8100';
const CACHE_HOST = process.env.CACHE_ENDPOINT ?? 'localhost';
const CACHE_PORT = Number(process.env.CACHE_PORT ?? 6380);
const TABLE_NAME = `orders-it-${Date.now()}`;
const TTL = 60;

const dynamoDb = new DynamoDBClient({
  endpoint: DYNAMODB_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const redis = new Redis({ host: CACHE_HOST, port: CACHE_PORT, lazyConnect: true });

async function invoke(
  handler: LambdaHttpHandler,
  event: APIGatewayProxyEventV2,
): Promise<{ status: number; body: any; headers: Record<string, unknown> }> {
  const result = await handler(event, lambdaContext);
  return {
    status: result.statusCode ?? 0,
    body: result.body ? JSON.parse(result.body) : undefined,
    headers: (result.headers ?? {}) as Record<string, unknown>,
  };
}

const sampleItems = [
  { sku: 'KB-01', name: 'Mechanical keyboard', quantity: 1, unitPrice: 8999 },
  { sku: 'MS-02', name: 'Wireless mouse', quantity: 2, unitPrice: 2499 },
];

async function createOrderFor(customerId: string): Promise<Order> {
  const response = await invoke(
    createOrder,
    httpEvent({ method: 'POST', pathParameters: { customerId }, body: { items: sampleItems } }),
  );
  expect(response.status).toBe(201);
  return response.body as Order;
}

const get = (customerId: string, orderId: string) =>
  invoke(getOrder, httpEvent({ method: 'GET', pathParameters: { customerId, orderId } }));

const patch = (customerId: string, orderId: string, status: string) =>
  invoke(
    updateOrderStatus,
    httpEvent({ method: 'PATCH', pathParameters: { customerId, orderId }, body: { status } }),
  );

const list = (customerId: string, query: Record<string, string> = {}) =>
  invoke(
    listOrders,
    httpEvent({ method: 'GET', pathParameters: { customerId }, queryStringParameters: query }),
  );

beforeAll(async () => {
  Object.assign(process.env, {
    AWS_REGION: 'us-east-1',
    TABLE_NAME,
    DYNAMODB_ENDPOINT,
    CACHE_ENDPOINT: CACHE_HOST,
    CACHE_PORT: String(CACHE_PORT),
    CACHE_TLS: 'false',
    CACHE_CLUSTER_MODE: 'false',
    CACHE_TTL_SECONDS: String(TTL),
  });
  setDependencies(undefined); // rebuild the container with the environment above

  await dynamoDb.send(new CreateTableCommand(ordersTableDefinition(TABLE_NAME)));
  await redis.connect();
});

afterAll(async () => {
  await dynamoDb.send(new DeleteTableCommand({ TableName: TABLE_NAME }));
  await getDependencies().close();
  setDependencies(undefined);
  redis.disconnect();
  dynamoDb.destroy();
});

describe('order lifecycle with cache-aside', () => {
  it('creates, caches, updates, invalidates and re-reads an order', async () => {
    const customerId = `c-${ulid()}`;

    // Create: 201 + Location header, nothing cached yet.
    const created = await invoke(
      createOrder,
      httpEvent({ method: 'POST', pathParameters: { customerId }, body: { items: sampleItems } }),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ customerId, status: 'PENDING', totalAmount: 13997 });
    expect(created.headers.location).toBe(
      `/customers/${customerId}/orders/${created.body.orderId}`,
    );
    const { orderId } = created.body as Order;
    const cacheKey = orderCacheKey(customerId, orderId);
    expect(await redis.exists(cacheKey)).toBe(0);

    // First read: cache miss -> DynamoDB -> the order is now in Valkey with a TTL.
    const firstRead = await get(customerId, orderId);
    expect(firstRead.status).toBe(200);
    expect(firstRead.body).toEqual(created.body);
    expect(JSON.parse((await redis.get(cacheKey))!)).toEqual(created.body);
    const ttl = await redis.ttl(cacheKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(TTL * 1.1);

    // Second read: cache hit returns the same data.
    expect((await get(customerId, orderId)).body).toEqual(created.body);

    // Update: DynamoDB is written, then the cache entry is deleted.
    const paid = await patch(customerId, orderId, 'PAID');
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('PAID');
    expect(await redis.exists(cacheKey)).toBe(0);

    // Next read reloads the new version (no stale PENDING from the cache).
    expect((await get(customerId, orderId)).body.status).toBe('PAID');
  });

  it('serves the cached value even if DynamoDB changed behind the cache (bounded by TTL)', async () => {
    const customerId = `c-${ulid()}`;
    const order = await createOrderFor(customerId);
    await get(customerId, order.orderId); // populate the cache

    // Simulate a write that bypassed the service (and so did not invalidate the cache).
    const cacheKey = orderCacheKey(customerId, order.orderId);
    await redis.set(cacheKey, JSON.stringify({ ...order, status: 'SHIPPED' }), 'EX', TTL);

    expect((await get(customerId, order.orderId)).body.status).toBe('SHIPPED');
  });
});

describe('status transitions', () => {
  it('enforces the state machine atomically in DynamoDB', async () => {
    const customerId = `c-${ulid()}`;
    const { orderId } = await createOrderFor(customerId);

    const skip = await patch(customerId, orderId, 'DELIVERED');
    expect(skip.status).toBe(409);
    expect(skip.body.error.details).toEqual({
      currentStatus: 'PENDING',
      requestedStatus: 'DELIVERED',
    });

    expect((await patch(customerId, orderId, 'PAID')).status).toBe(200);
    expect((await patch(customerId, orderId, 'SHIPPED')).status).toBe(200);
    expect((await patch(customerId, orderId, 'CANCELLED')).status).toBe(409);
    expect((await patch(customerId, orderId, 'DELIVERED')).status).toBe(200);
    expect((await patch(customerId, orderId, 'PENDING')).status).toBe(409);
  });

  it('returns 404 when updating an order that does not exist', async () => {
    const response = await patch('c-missing', ulid(), 'PAID');
    expect(response.status).toBe(404);
  });
});

describe('reads and validation', () => {
  it('returns 404 for unknown orders and 400 for malformed IDs', async () => {
    expect((await get('c-unknown', ulid())).status).toBe(404);
    expect((await get('c-unknown', 'not-a-ulid')).status).toBe(400);
  });

  it('does not let a customer read another customer’s order', async () => {
    const owner = `c-${ulid()}`;
    const { orderId } = await createOrderFor(owner);
    expect((await get(`c-${ulid()}`, orderId)).status).toBe(404);
  });

  it('rejects invalid bodies with a 400 and per-field details', async () => {
    const response = await invoke(
      createOrder,
      httpEvent({
        method: 'POST',
        pathParameters: { customerId: 'c-1' },
        body: { items: [{ sku: 'A', name: 'A', quantity: -1, unitPrice: 1.5 }] },
      }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.map((d: { path: string }) => d.path)).toEqual([
      'items.0.quantity',
      'items.0.unitPrice',
    ]);
  });
});

describe('listing orders (Query on partition key + sort key)', () => {
  it('returns a customer’s orders newest first, paginated with nextToken', async () => {
    const customerId = `c-${ulid()}`;
    const created: Order[] = [];
    for (let i = 0; i < 5; i++) created.push(await createOrderFor(customerId));
    await createOrderFor(`c-${ulid()}`); // another customer: must never show up

    const newestFirst = created.map((o) => o.orderId).reverse();

    const page1 = await list(customerId, { limit: '2' });
    expect(page1.status).toBe(200);
    expect(page1.body.items.map((o: Order) => o.orderId)).toEqual(newestFirst.slice(0, 2));
    expect(page1.body.nextToken).toEqual(expect.any(String));

    const page2 = await list(customerId, { limit: '2', nextToken: page1.body.nextToken });
    const page3 = await list(customerId, { limit: '2', nextToken: page2.body.nextToken });
    const all = [...page1.body.items, ...page2.body.items, ...page3.body.items];
    expect(all.map((o: Order) => o.orderId)).toEqual(newestFirst);
  });

  it('filters by creation date with a sort-key range (BETWEEN), not a scan', async () => {
    const customerId = `c-${ulid()}`;
    const repository = new DynamoDbOrderRepository(
      DynamoDBDocumentClient.from(dynamoDb),
      TABLE_NAME,
    );
    const at = (iso: string): Order => ({
      orderId: ulid(Date.parse(iso)),
      customerId,
      status: 'PENDING',
      items: sampleItems,
      currency: 'USD',
      totalAmount: 13997,
      createdAt: iso,
      updatedAt: iso,
    });
    const january = at('2026-01-15T10:00:00.000Z');
    const february = at('2026-02-15T10:00:00.000Z');
    const march = at('2026-03-15T10:00:00.000Z');
    for (const order of [january, february, march]) await repository.create(order);

    const februaryOnly = await list(customerId, {
      from: '2026-02-01T00:00:00Z',
      to: '2026-02-28T23:59:59Z',
    });
    expect(februaryOnly.body.items.map((o: Order) => o.orderId)).toEqual([february.orderId]);

    const sinceFebruary = await list(customerId, { from: '2026-02-01T00:00:00Z' });
    expect(sinceFebruary.body.items.map((o: Order) => o.orderId)).toEqual([
      march.orderId,
      february.orderId,
    ]);
  });

  it("rejects a nextToken that points into another customer's partition", async () => {
    const victim = `c-${ulid()}`;
    const order = await createOrderFor(victim);
    const forged = Buffer.from(
      JSON.stringify({ PK: `CUSTOMER#${victim}`, SK: `ORDER#${order.orderId}` }),
    ).toString('base64url');

    const response = await list(`c-${ulid()}`, { nextToken: forged });
    expect(response.status).toBe(400);
  });
});

import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { Order, OrderStatus } from '../domain/order';
import { ConflictError, NotFoundError } from '../lib/errors';
import { keys, ORDER_SK_PREFIX, orderSortKeyRange } from './keys';
import type {
  ListOrdersOptions,
  OrderPage,
  OrderRepository,
  UpdateStatusParams,
} from './order-repository';
import { decodeNextToken, encodeNextToken } from './pagination';

const ENTITY_TYPE = 'ORDER';

type OrderRecord = Order & { PK: string; SK: string; entityType: typeof ENTITY_TYPE };

function toRecord(order: Order): OrderRecord {
  return {
    PK: keys.customer(order.customerId),
    SK: keys.order(order.orderId),
    entityType: ENTITY_TYPE,
    ...order,
  };
}

/** Explicit mapping: storage-only attributes (PK, SK, entityType) never leak into the API. */
function fromRecord(item: Record<string, unknown>): Order {
  const record = item as unknown as OrderRecord;
  return {
    orderId: record.orderId,
    customerId: record.customerId,
    status: record.status,
    items: record.items,
    currency: record.currency,
    totalAmount: record.totalAmount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function isConditionalCheckFailed(
  error: unknown,
): error is Error & { Item?: Record<string, AttributeValue> } {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

export class DynamoDbOrderRepository implements OrderRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async create(order: Order): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        Item: toRecord(order),
        // Never overwrite an existing item with the same PK+SK.
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  }

  /** GetItem: the cheapest, fastest read — needs the full primary key (PK + SK). */
  async get(
    customerId: string,
    orderId: string,
    options: { consistentRead?: boolean } = {},
  ): Promise<Order | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: keys.customer(customerId), SK: keys.order(orderId) },
        ConsistentRead: options.consistentRead ?? false,
      }),
    );
    return Item ? fromRecord(Item) : undefined;
  }

  /**
   * Query one partition (one customer), newest first.
   * - No date filter: `begins_with(SK, 'ORDER#')` returns every order of the customer.
   * - Date filter: `SK BETWEEN start AND end` uses the ULID time prefix of the sort key.
   * Both are *key conditions*: DynamoDB reads only the matching items, unlike a
   * FilterExpression, which reads (and bills) first and discards afterwards.
   */
  async listByCustomer(customerId: string, options: ListOrdersOptions): Promise<OrderPage> {
    const pk = keys.customer(customerId);
    const hasDateRange = options.from !== undefined || options.to !== undefined;
    const range = orderSortKeyRange(options.from, options.to);

    const { Items = [], LastEvaluatedKey } = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: hasDateRange
          ? 'PK = :pk AND SK BETWEEN :start AND :end'
          : 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: hasDateRange
          ? { ':pk': pk, ':start': range.start, ':end': range.end }
          : { ':pk': pk, ':prefix': ORDER_SK_PREFIX },
        ScanIndexForward: false, // descending sort key => newest orders first
        Limit: options.limit,
        ExclusiveStartKey: decodeNextToken(options.nextToken, pk),
      }),
    );

    return { orders: Items.map(fromRecord), nextToken: encodeNextToken(LastEvaluatedKey) };
  }

  /**
   * Atomic, conditional state transition in a single request. The ConditionExpression
   * enforces both "the order exists" and "the current status allows this transition",
   * so two concurrent requests cannot both succeed with conflicting transitions.
   */
  async updateStatus(params: UpdateStatusParams): Promise<Order> {
    const { customerId, orderId, status, allowedFrom, updatedAt } = params;
    if (allowedFrom.length === 0) {
      throw new Error('updateStatus requires at least one allowed previous status');
    }

    const fromValues = Object.fromEntries(allowedFrom.map((s, i) => [`:from${i}`, s]));

    try {
      const { Attributes } = await this.db.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: keys.customer(customerId), SK: keys.order(orderId) },
          UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
          ConditionExpression: `attribute_exists(PK) AND #status IN (${Object.keys(fromValues).join(', ')})`,
          // `status` is a DynamoDB reserved word, so it must be aliased.
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': status, ':updatedAt': updatedAt, ...fromValues },
          ReturnValues: 'ALL_NEW',
          // On failure, DynamoDB returns the current item so we can tell 404 from 409
          // without a second read.
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return fromRecord(Attributes ?? {});
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        if (!error.Item) throw new NotFoundError(`Order ${orderId} not found`);
        const currentStatus = unmarshall(error.Item).status as OrderStatus;
        throw new ConflictError(`Cannot change order status from ${currentStatus} to ${status}`, {
          currentStatus,
          requestedStatus: status,
        });
      }
      throw error;
    }
  }
}

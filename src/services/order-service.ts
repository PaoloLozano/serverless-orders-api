import type { Logger } from '@aws-lambda-powertools/logger';
import { MetricUnit, type Metrics } from '@aws-lambda-powertools/metrics';
import { monotonicFactory } from 'ulid';
import type { Cache } from '../cache/cache';
import {
  allowedPreviousStatuses,
  calculateTotal,
  type CreateOrderInput,
  type ListOrdersQuery,
  type Order,
  type OrderStatus,
} from '../domain/order';
import { ConflictError, NotFoundError } from '../lib/errors';
import type { OrderPage, OrderRepository } from '../repositories/order-repository';

export interface OrderServiceDependencies {
  repository: OrderRepository;
  cache: Cache;
  cacheTtlSeconds: number;
  logger: Logger;
  metrics: Metrics;
  /** Injectable clock so tests are deterministic. */
  now?: () => Date;
}

/**
 * Cache keys are namespaced and versioned. Bumping `v1` invalidates every cached order
 * at once if the Order shape ever changes in a backwards-incompatible way.
 */
export function orderCacheKey(customerId: string, orderId: string): string {
  return `orders:v1:${customerId}:${orderId}`;
}

/** Monotonic: two orders created in the same millisecond still get increasing IDs. */
const newOrderId = monotonicFactory();

export class OrderService {
  private readonly repository: OrderRepository;
  private readonly cache: Cache;
  private readonly cacheTtlSeconds: number;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly now: () => Date;

  constructor(deps: OrderServiceDependencies) {
    this.repository = deps.repository;
    this.cache = deps.cache;
    this.cacheTtlSeconds = deps.cacheTtlSeconds;
    this.logger = deps.logger;
    this.metrics = deps.metrics;
    this.now = deps.now ?? (() => new Date());
  }

  async createOrder(customerId: string, input: CreateOrderInput): Promise<Order> {
    const now = this.now();
    const timestamp = now.toISOString();
    const order: Order = {
      // ULID: unique like a UUID, but sortable by creation time (see repositories/keys.ts).
      orderId: newOrderId(now.getTime()),
      customerId,
      status: 'PENDING',
      items: input.items,
      currency: input.currency,
      totalAmount: calculateTotal(input.items),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.repository.create(order);
    // Cache-aside does not write on create: the first read loads the order into the cache.
    this.metrics.addMetric('OrderCreated', MetricUnit.Count, 1);
    return order;
  }

  /**
   * Cache-aside (a.k.a. lazy loading) read path:
   *   1. Read from the cache.                       Hit  -> return it.
   *   2. Miss -> read from DynamoDB (the source of truth).
   *   3. Store the result in the cache with a TTL, then return it.
   * The application — not the cache — loads the data, hence "aside".
   */
  async getOrder(customerId: string, orderId: string): Promise<Order> {
    const key = orderCacheKey(customerId, orderId);

    // 1. Cache
    const cached = await this.readFromCache(key);
    if (cached) {
      this.metrics.addMetric('CacheHit', MetricUnit.Count, 1);
      return cached;
    }
    this.metrics.addMetric('CacheMiss', MetricUnit.Count, 1);

    // 2. Database. Strongly consistent on purpose: right after an update invalidated the
    //    cache, an eventually consistent read could still return the previous version and
    //    we would put stale data back into the cache for a full TTL.
    const order = await this.repository.get(customerId, orderId, { consistentRead: true });
    if (!order) {
      throw new NotFoundError(`Order ${orderId} not found`);
    }

    // 3. Populate the cache for the next readers.
    await this.writeToCache(key, order);
    return order;
  }

  /**
   * Lists are not cached: they are paginated and filtered (many key variations) and any
   * write would have to invalidate all of them. A single-partition Query is already fast.
   */
  async listOrders(customerId: string, query: ListOrdersQuery): Promise<OrderPage> {
    return this.repository.listByCustomer(customerId, {
      limit: query.limit,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      nextToken: query.nextToken,
    });
  }

  /**
   * Cache-aside write path: update the database first, then invalidate (delete) the cached
   * copy. Deleting instead of overwriting avoids two concurrent writers leaving the older
   * value in the cache; the next read simply reloads the latest version from DynamoDB.
   */
  async updateOrderStatus(
    customerId: string,
    orderId: string,
    status: OrderStatus,
  ): Promise<Order> {
    const allowedFrom = allowedPreviousStatuses(status);
    if (allowedFrom.length === 0) {
      throw new ConflictError(`Orders cannot be moved to ${status}`);
    }

    const updated = await this.repository.updateStatus({
      customerId,
      orderId,
      status,
      allowedFrom,
      updatedAt: this.now().toISOString(),
    });

    await this.invalidate(orderCacheKey(customerId, orderId));
    this.metrics.addMetric('OrderStatusChanged', MetricUnit.Count, 1);
    return updated;
  }

  // -------------------------------------------------------------------------
  // The cache is an optimisation, never a dependency: every cache failure is logged
  // and the request continues against DynamoDB ("fail open").
  // -------------------------------------------------------------------------

  private async readFromCache(key: string): Promise<Order | undefined> {
    try {
      const value = await this.cache.get(key);
      return value ? (JSON.parse(value) as Order) : undefined;
    } catch (error) {
      this.recordCacheError('get', key, error);
      return undefined;
    }
  }

  private async writeToCache(key: string, order: Order): Promise<void> {
    try {
      await this.cache.set(key, JSON.stringify(order), this.ttlWithJitter());
    } catch (error) {
      this.recordCacheError('set', key, error);
    }
  }

  private async invalidate(key: string): Promise<void> {
    try {
      await this.cache.delete(key);
    } catch (error) {
      // Worst case the stale entry lives until its TTL expires.
      this.recordCacheError('delete', key, error);
    }
  }

  /**
   * Adds up to +10% random jitter so keys cached at the same moment do not all expire at
   * the same moment and send a burst of misses to DynamoDB.
   */
  private ttlWithJitter(): number {
    return this.cacheTtlSeconds + Math.floor(Math.random() * this.cacheTtlSeconds * 0.1);
  }

  private recordCacheError(operation: string, key: string, error: unknown): void {
    this.metrics.addMetric('CacheError', MetricUnit.Count, 1);
    this.logger.warn('Cache operation failed, falling back to DynamoDB', {
      operation,
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics } from '@aws-lambda-powertools/metrics';
import { describe, expect, it, vi } from 'vitest';
import type { Cache } from '../../../src/cache/cache';
import type { Order } from '../../../src/domain/order';
import { ConflictError, NotFoundError } from '../../../src/lib/errors';
import type { OrderRepository } from '../../../src/repositories/order-repository';
import { orderCacheKey, OrderService } from '../../../src/services/order-service';
import { InMemoryCache } from '../../support/in-memory-cache';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const TTL = 300;

const order: Order = {
  orderId: '01JA2B3C4D5E6F7G8H9JKMNPQR',
  customerId: 'c-1',
  status: 'PENDING',
  items: [{ sku: 'KB-01', name: 'Keyboard', quantity: 2, unitPrice: 4500 }],
  currency: 'USD',
  totalAmount: 9000,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};
const key = orderCacheKey(order.customerId, order.orderId);

function setup(cache: Cache = new InMemoryCache()) {
  const repository = {
    create: vi.fn<OrderRepository['create']>().mockResolvedValue(undefined),
    get: vi.fn<OrderRepository['get']>().mockResolvedValue(order),
    listByCustomer: vi.fn<OrderRepository['listByCustomer']>(),
    updateStatus: vi.fn<OrderRepository['updateStatus']>(),
  };
  const metrics = new Metrics();
  const addMetric = vi.spyOn(metrics, 'addMetric');
  const service = new OrderService({
    repository,
    cache,
    cacheTtlSeconds: TTL,
    logger: new Logger(),
    metrics,
    now: () => NOW,
  });
  const metricNames = () => addMetric.mock.calls.map(([name]) => name);
  return { service, repository, cache, metricNames };
}

/** A cache whose every operation fails, as if Valkey were unreachable. */
function brokenCache(): Cache {
  const fail = () => Promise.reject(new Error('ECONNREFUSED'));
  return { get: fail, set: fail, delete: fail, close: async () => undefined };
}

describe('OrderService.getOrder — cache-aside read', () => {
  it('on a miss, reads DynamoDB with a strongly consistent read and populates the cache', async () => {
    const cache = new InMemoryCache();
    const { service, repository, metricNames } = setup(cache);

    await expect(service.getOrder('c-1', order.orderId)).resolves.toEqual(order);

    expect(repository.get).toHaveBeenCalledWith('c-1', order.orderId, { consistentRead: true });
    expect(JSON.parse(cache.entries.get(key)!.value)).toEqual(order);
    expect(metricNames()).toEqual(['CacheMiss']);
  });

  it('on a hit, returns the cached order without calling DynamoDB', async () => {
    const cache = new InMemoryCache();
    await cache.set(key, JSON.stringify(order), TTL);
    const { service, repository, metricNames } = setup(cache);

    await expect(service.getOrder('c-1', order.orderId)).resolves.toEqual(order);

    expect(repository.get).not.toHaveBeenCalled();
    expect(metricNames()).toEqual(['CacheHit']);
  });

  it('serves the second read from the cache', async () => {
    const { service, repository, metricNames } = setup();

    await service.getOrder('c-1', order.orderId);
    await service.getOrder('c-1', order.orderId);

    expect(repository.get).toHaveBeenCalledTimes(1);
    expect(metricNames()).toEqual(['CacheMiss', 'CacheHit']);
  });

  it('stores entries with a TTL plus up to 10% jitter', async () => {
    const cache = new InMemoryCache();
    const { service } = setup(cache);

    await service.getOrder('c-1', order.orderId);

    const { ttlSeconds } = cache.entries.get(key)!;
    expect(ttlSeconds).toBeGreaterThanOrEqual(TTL);
    expect(ttlSeconds).toBeLessThanOrEqual(TTL * 1.1);
  });

  it('fails open: when the cache is down, the order is still served from DynamoDB', async () => {
    const { service, repository, metricNames } = setup(brokenCache());

    await expect(service.getOrder('c-1', order.orderId)).resolves.toEqual(order);

    expect(repository.get).toHaveBeenCalledTimes(1);
    expect(metricNames()).toEqual(['CacheError', 'CacheMiss', 'CacheError']);
  });

  it('treats a corrupted cache entry as a miss', async () => {
    const cache = new InMemoryCache();
    await cache.set(key, '{not json', TTL);
    const { service, repository } = setup(cache);

    await expect(service.getOrder('c-1', order.orderId)).resolves.toEqual(order);
    expect(repository.get).toHaveBeenCalledTimes(1);
  });

  it('throws NotFoundError and caches nothing when the order does not exist', async () => {
    const cache = new InMemoryCache();
    const { service, repository } = setup(cache);
    repository.get.mockResolvedValue(undefined);

    await expect(service.getOrder('c-1', order.orderId)).rejects.toBeInstanceOf(NotFoundError);
    expect(cache.entries.size).toBe(0);
  });
});

describe('OrderService.updateOrderStatus — write + invalidate', () => {
  it('updates DynamoDB first and then deletes the cached copy', async () => {
    const cache = new InMemoryCache();
    await cache.set(key, JSON.stringify(order), TTL);
    const deleteSpy = vi.spyOn(cache, 'delete');
    const { service, repository } = setup(cache);
    const paid = { ...order, status: 'PAID' as const };
    repository.updateStatus.mockResolvedValue(paid);

    await expect(service.updateOrderStatus('c-1', order.orderId, 'PAID')).resolves.toEqual(paid);

    expect(repository.updateStatus).toHaveBeenCalledWith({
      customerId: 'c-1',
      orderId: order.orderId,
      status: 'PAID',
      allowedFrom: ['PENDING'],
      updatedAt: NOW.toISOString(),
    });
    expect(repository.updateStatus.mock.invocationCallOrder[0]).toBeLessThan(
      deleteSpy.mock.invocationCallOrder[0]!,
    );
    expect(cache.entries.has(key)).toBe(false);
  });

  it('next read after an update reloads the new version from DynamoDB', async () => {
    const { service, repository } = setup();
    await service.getOrder('c-1', order.orderId); // cached as PENDING

    const paid = { ...order, status: 'PAID' as const };
    repository.updateStatus.mockResolvedValue(paid);
    repository.get.mockResolvedValue(paid);
    await service.updateOrderStatus('c-1', order.orderId, 'PAID');

    await expect(service.getOrder('c-1', order.orderId)).resolves.toMatchObject({ status: 'PAID' });
    expect(repository.get).toHaveBeenCalledTimes(2);
  });

  it('rejects moving an order back to PENDING without touching DynamoDB', async () => {
    const { service, repository } = setup();

    await expect(service.updateOrderStatus('c-1', order.orderId, 'PENDING')).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });

  it('keeps the cache untouched when the database rejects the update', async () => {
    const cache = new InMemoryCache();
    await cache.set(key, JSON.stringify(order), TTL);
    const { service, repository } = setup(cache);
    repository.updateStatus.mockRejectedValue(new ConflictError('invalid transition'));

    await expect(service.updateOrderStatus('c-1', order.orderId, 'DELIVERED')).rejects.toThrow(
      ConflictError,
    );
    expect(cache.entries.has(key)).toBe(true);
  });

  it('still succeeds when cache invalidation fails (the TTL bounds staleness)', async () => {
    const { service, repository, metricNames } = setup(brokenCache());
    repository.updateStatus.mockResolvedValue({ ...order, status: 'CANCELLED' });

    await expect(
      service.updateOrderStatus('c-1', order.orderId, 'CANCELLED'),
    ).resolves.toMatchObject({ status: 'CANCELLED' });
    expect(repository.updateStatus.mock.calls[0]![0].allowedFrom).toEqual(['PENDING', 'PAID']);
    expect(metricNames()).toContain('CacheError');
  });
});

describe('OrderService.createOrder', () => {
  it('creates a PENDING order with a ULID, a computed total and no cache write', async () => {
    const cache = new InMemoryCache();
    const { service, repository } = setup(cache);

    const created = await service.createOrder('c-1', {
      currency: 'EUR',
      items: [
        { sku: 'A', name: 'A', quantity: 3, unitPrice: 250 },
        { sku: 'B', name: 'B', quantity: 1, unitPrice: 1000 },
      ],
    });

    expect(created).toMatchObject({
      customerId: 'c-1',
      status: 'PENDING',
      currency: 'EUR',
      totalAmount: 1750,
      createdAt: NOW.toISOString(),
    });
    expect(created.orderId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(repository.create).toHaveBeenCalledWith(created);
    expect(cache.entries.size).toBe(0);
  });

  it('generates increasing IDs for orders created in the same millisecond', async () => {
    const { service } = setup();
    const input = { currency: 'USD', items: [{ sku: 'A', name: 'A', quantity: 1, unitPrice: 1 }] };

    const first = await service.createOrder('c-1', input);
    const second = await service.createOrder('c-1', input);

    expect(second.orderId > first.orderId).toBe(true);
  });
});

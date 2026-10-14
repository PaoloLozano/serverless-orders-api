import { describe, expect, it } from 'vitest';
import {
  allowedPreviousStatuses,
  calculateTotal,
  canTransition,
  createOrderSchema,
  customerIdSchema,
  listOrdersQuerySchema,
  orderIdSchema,
} from '../../../src/domain/order';

describe('order status machine', () => {
  it.each([
    ['PENDING', 'PAID'],
    ['PENDING', 'CANCELLED'],
    ['PAID', 'SHIPPED'],
    ['PAID', 'CANCELLED'],
    ['SHIPPED', 'DELIVERED'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ['PENDING', 'SHIPPED'],
    ['SHIPPED', 'CANCELLED'],
    ['DELIVERED', 'PENDING'],
    ['CANCELLED', 'PAID'],
    ['PAID', 'PAID'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('computes the statuses that can reach a target status', () => {
    expect(allowedPreviousStatuses('CANCELLED')).toEqual(['PENDING', 'PAID']);
    expect(allowedPreviousStatuses('DELIVERED')).toEqual(['SHIPPED']);
    expect(allowedPreviousStatuses('PENDING')).toEqual([]);
  });
});

describe('calculateTotal', () => {
  it('sums quantity * unitPrice in integer cents', () => {
    expect(
      calculateTotal([
        { sku: 'A', name: 'A', quantity: 2, unitPrice: 1050 },
        { sku: 'B', name: 'B', quantity: 1, unitPrice: 99 },
      ]),
    ).toBe(2199);
  });
});

describe('input validation', () => {
  it('rejects customer IDs containing the key delimiter', () => {
    expect(customerIdSchema.safeParse('c-123').success).toBe(true);
    expect(customerIdSchema.safeParse('c#123').success).toBe(false);
    expect(customerIdSchema.safeParse('').success).toBe(false);
  });

  it('accepts only canonical ULIDs as order IDs', () => {
    expect(orderIdSchema.safeParse('01JA2B3C4D5E6F7G8H9JKMNPQR').success).toBe(true);
    expect(orderIdSchema.safeParse('01ja2b3c4d5e6f7g8h9jkmnpqr').success).toBe(false);
    expect(orderIdSchema.safeParse('not-a-ulid').success).toBe(false);
  });

  it('defaults the currency and rejects unknown fields', () => {
    const item = { sku: 'A', name: 'Item', quantity: 1, unitPrice: 100 };
    expect(createOrderSchema.parse({ items: [item] }).currency).toBe('USD');
    expect(createOrderSchema.safeParse({ items: [item], discount: 10 }).success).toBe(false);
  });

  it('rejects empty orders, fractional prices and non-positive quantities', () => {
    expect(createOrderSchema.safeParse({ items: [] }).success).toBe(false);
    expect(
      createOrderSchema.safeParse({
        items: [{ sku: 'A', name: 'A', quantity: 1, unitPrice: 9.99 }],
      }).success,
    ).toBe(false);
    expect(
      createOrderSchema.safeParse({ items: [{ sku: 'A', name: 'A', quantity: 0, unitPrice: 100 }] })
        .success,
    ).toBe(false);
  });

  it('coerces and bounds list query parameters', () => {
    expect(listOrdersQuerySchema.parse({}).limit).toBe(20);
    expect(listOrdersQuerySchema.parse({ limit: '5' }).limit).toBe(5);
    expect(listOrdersQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
    expect(
      listOrdersQuerySchema.safeParse({
        from: '2026-02-01T00:00:00Z',
        to: '2026-01-01T00:00:00Z',
      }).success,
    ).toBe(false);
  });
});

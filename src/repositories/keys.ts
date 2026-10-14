import { encodeTime, TIME_LEN, TIME_MAX } from 'ulid';

/**
 * Key design for the single `Orders` table.
 *
 *   PK (partition key)  = CUSTOMER#<customerId>
 *   SK (sort key)       = ORDER#<orderId>          (orderId is a ULID)
 *
 * - The partition key groups every order of one customer into one "item collection",
 *   so "list a customer's orders" is a single Query, never a Scan. customerId has high
 *   cardinality, which spreads traffic evenly across DynamoDB partitions.
 * - The sort key orders items inside the partition. ULIDs start with a 48-bit timestamp
 *   and sort lexicographically by creation time, so the sort key gives chronological
 *   ordering and date-range queries for free.
 * - Prefixes (`CUSTOMER#`, `ORDER#`) make keys self-describing and leave room for other
 *   entity types in the same partition later (e.g. SK = `PROFILE`) without collisions.
 */
export const ORDER_SK_PREFIX = 'ORDER#';

export const keys = {
  customer: (customerId: string): string => `CUSTOMER#${customerId}`,
  order: (orderId: string): string => `${ORDER_SK_PREFIX}${orderId}`,
};

const RANDOM_LEN = 16;
const LOWEST_RANDOM = '0'.repeat(RANDOM_LEN); // first symbol of Crockford base32
const HIGHEST_RANDOM = 'Z'.repeat(RANDOM_LEN); // last symbol of Crockford base32

function encodeUlidTime(date: Date): string {
  const ms = Math.min(Math.max(date.getTime(), 0), TIME_MAX);
  return encodeTime(ms, TIME_LEN);
}

/**
 * Sort-key bounds for "orders created between `from` and `to`" (both inclusive).
 * Because the ULID time component comes first, every order created in the window sorts
 * between the smallest and the largest ULID that can exist for those two instants.
 */
export function orderSortKeyRange(from?: Date, to?: Date): { start: string; end: string } {
  return {
    start: keys.order(encodeUlidTime(from ?? new Date(0)) + LOWEST_RANDOM),
    end: keys.order(encodeUlidTime(to ?? new Date(TIME_MAX)) + HIGHEST_RANDOM),
  };
}

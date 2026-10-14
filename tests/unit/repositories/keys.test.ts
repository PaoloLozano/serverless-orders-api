import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { keys, orderSortKeyRange } from '../../../src/repositories/keys';

describe('DynamoDB keys', () => {
  it('builds prefixed partition and sort keys', () => {
    expect(keys.customer('c-1')).toBe('CUSTOMER#c-1');
    expect(keys.order('01JA2B3C4D5E6F7G8H9JKMNPQR')).toBe('ORDER#01JA2B3C4D5E6F7G8H9JKMNPQR');
  });

  it('sorts order sort keys chronologically because ULIDs are time-ordered', () => {
    const older = keys.order(ulid(Date.parse('2026-01-01T00:00:00Z')));
    const newer = keys.order(ulid(Date.parse('2026-06-01T00:00:00Z')));
    expect([newer, older].sort()).toEqual([older, newer]);
  });

  it('builds an inclusive sort-key range that contains every order created in the window', () => {
    const from = new Date('2026-03-01T00:00:00Z');
    const to = new Date('2026-03-31T23:59:59.999Z');
    const { start, end } = orderSortKeyRange(from, to);

    const inside = [from, new Date('2026-03-15T12:00:00Z'), to].map((d) =>
      keys.order(ulid(d.getTime())),
    );
    const before = keys.order(ulid(from.getTime() - 1));
    const after = keys.order(ulid(to.getTime() + 1));

    for (const sk of inside) {
      expect(sk >= start && sk <= end).toBe(true);
    }
    expect(before < start).toBe(true);
    expect(after > end).toBe(true);
  });

  it('leaves the range open when bounds are omitted', () => {
    const { start, end } = orderSortKeyRange();
    const sk = keys.order(ulid());
    expect(sk > start && sk < end).toBe(true);
  });
});

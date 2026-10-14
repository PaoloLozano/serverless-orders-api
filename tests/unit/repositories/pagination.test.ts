import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../src/lib/errors';
import { decodeNextToken, encodeNextToken } from '../../../src/repositories/pagination';

const key = { PK: 'CUSTOMER#c-1', SK: 'ORDER#01JA2B3C4D5E6F7G8H9JKMNPQR' };

describe('pagination tokens', () => {
  it('round-trips a LastEvaluatedKey as a URL-safe token', () => {
    const token = encodeNextToken(key);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeNextToken(token, 'CUSTOMER#c-1')).toEqual(key);
  });

  it('returns undefined when there are no more pages', () => {
    expect(encodeNextToken(undefined)).toBeUndefined();
    expect(decodeNextToken(undefined, 'CUSTOMER#c-1')).toBeUndefined();
  });

  it("rejects a token from another customer's partition", () => {
    const token = encodeNextToken(key);
    expect(() => decodeNextToken(token, 'CUSTOMER#someone-else')).toThrow(ValidationError);
  });

  it('rejects malformed tokens', () => {
    expect(() => decodeNextToken('not-base64-json', 'CUSTOMER#c-1')).toThrow(ValidationError);
    const extraFields = encodeNextToken({ ...key, admin: true });
    expect(() => decodeNextToken(extraFields, 'CUSTOMER#c-1')).toThrow(ValidationError);
    const wrongEntity = encodeNextToken({ PK: 'CUSTOMER#c-1', SK: 'PROFILE' });
    expect(() => decodeNextToken(wrongEntity, 'CUSTOMER#c-1')).toThrow(ValidationError);
  });
});

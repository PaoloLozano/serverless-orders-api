import { ValidationError } from '../lib/errors';
import { ORDER_SK_PREFIX } from './keys';

interface OrderCursor {
  PK: string;
  SK: string;
}

function isOrderCursor(value: unknown): value is OrderCursor {
  if (typeof value !== 'object' || value === null) return false;
  const { PK, SK } = value as Record<string, unknown>;
  return typeof PK === 'string' && typeof SK === 'string' && Object.keys(value).length === 2;
}

/**
 * DynamoDB paginates with `LastEvaluatedKey`. We hand it to clients as an opaque,
 * URL-safe token so they never see (or depend on) our key format.
 */
export function encodeNextToken(lastEvaluatedKey?: Record<string, unknown>): string | undefined {
  if (!lastEvaluatedKey) return undefined;
  return Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf8').toString('base64url');
}

/**
 * Tokens come from the client, so they are untrusted input. Besides checking the shape,
 * we verify the token belongs to the partition being queried: otherwise a crafted token
 * could make the Query start inside another customer's data.
 */
export function decodeNextToken(
  token: string | undefined,
  expectedPartitionKey: string,
): OrderCursor | undefined {
  if (!token) return undefined;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('Invalid nextToken');
  }

  if (
    !isOrderCursor(decoded) ||
    decoded.PK !== expectedPartitionKey ||
    !decoded.SK.startsWith(ORDER_SK_PREFIX)
  ) {
    throw new ValidationError('Invalid nextToken');
  }
  return decoded;
}

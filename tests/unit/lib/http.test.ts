import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../../src/lib/errors';
import { httpHandler, parseJsonBody, validate } from '../../../src/lib/http';
import { httpEvent, lambdaContext } from '../../support/http-events';

describe('httpHandler', () => {
  it('serialises the route result as JSON', async () => {
    const handler = httpHandler(async () => ({
      statusCode: 201,
      body: { ok: true },
      headers: { location: '/x' },
    }));

    const result = await handler(httpEvent({ method: 'POST' }), lambdaContext);

    expect(result.statusCode).toBe(201);
    expect(result.headers).toMatchObject({ 'content-type': 'application/json', location: '/x' });
    expect(JSON.parse(result.body!)).toEqual({ ok: true });
  });

  it('maps application errors to their HTTP status and error code', async () => {
    const handler = httpHandler(async () => {
      throw new NotFoundError('Order X not found');
    });

    const result = await handler(httpEvent({ method: 'GET' }), lambdaContext);

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body!)).toEqual({
      error: { code: 'NOT_FOUND', message: 'Order X not found' },
    });
  });

  it('hides internal error details behind a generic 500', async () => {
    const handler = httpHandler(async () => {
      throw new Error('connection string leaked: secret');
    });

    const result = await handler(httpEvent({ method: 'GET' }), lambdaContext);

    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('secret');
    expect(JSON.parse(result.body!).error.code).toBe('INTERNAL_ERROR');
  });
});

describe('parseJsonBody', () => {
  it('parses plain and base64-encoded bodies', () => {
    expect(parseJsonBody(httpEvent({ method: 'POST', body: { a: 1 } }))).toEqual({ a: 1 });

    const encoded = { ...httpEvent({ method: 'POST' }), isBase64Encoded: true };
    encoded.body = Buffer.from('{"b":2}').toString('base64');
    expect(parseJsonBody(encoded)).toEqual({ b: 2 });
  });

  it('rejects missing or malformed bodies', () => {
    expect(() => parseJsonBody(httpEvent({ method: 'POST' }))).toThrow(ValidationError);
    expect(() => parseJsonBody(httpEvent({ method: 'POST', rawBody: '{oops' }))).toThrow(
      'Request body must be valid JSON',
    );
  });
});

describe('validate', () => {
  it('returns parsed data or throws a ValidationError listing every issue', () => {
    const schema = z.object({ name: z.string(), age: z.number().int() });

    expect(validate(schema, { name: 'Ana', age: 30 })).toEqual({ name: 'Ana', age: 30 });

    try {
      validate(schema, { name: 1, age: 1.5 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const details = (error as ValidationError).details as { path: string }[];
      expect(details.map((d) => d.path)).toEqual(['name', 'age']);
    }
  });
});

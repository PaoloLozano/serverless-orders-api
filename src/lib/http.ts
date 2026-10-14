import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import type { z } from 'zod';
import { AppError, ValidationError } from './errors';
import { logger, metrics } from './observability';

export interface HttpResponse {
  statusCode: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type HttpRoute = (event: APIGatewayProxyEventV2) => Promise<HttpResponse>;
export type LambdaHttpHandler = (
  event: APIGatewayProxyEventV2,
  context: Context,
) => Promise<APIGatewayProxyStructuredResultV2>;

function json(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? '' : JSON.stringify(body),
  };
}

function toErrorResponse(error: unknown): APIGatewayProxyStructuredResultV2 {
  if (error instanceof AppError) {
    logger.info('Request rejected', { code: error.code, reason: error.message });
    return json(error.statusCode, {
      error: { code: error.code, message: error.message, details: error.details },
    });
  }

  // Unknown errors are logged with their stack trace but never exposed to the client.
  logger.error('Unhandled error', error as Error);
  return json(500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}

/**
 * Wraps a route with the cross-cutting concerns every endpoint needs:
 * request-scoped log context, error-to-HTTP mapping and metric flushing.
 */
export function httpHandler(route: HttpRoute): LambdaHttpHandler {
  return async (event, context) => {
    logger.addContext(context);
    logger.appendKeys({ requestId: event.requestContext?.requestId, route: event.routeKey });

    try {
      const response = await route(event);
      return json(response.statusCode, response.body, response.headers);
    } catch (error) {
      return toErrorResponse(error);
    } finally {
      if (metrics.hasStoredMetrics()) metrics.publishStoredMetrics();
      logger.resetKeys();
    }
  };
}

export function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) {
    throw new ValidationError('Request body is required');
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
}

/** Validates untrusted input against a zod schema and returns the typed, parsed value. */
export function validate<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      'Request validation failed',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

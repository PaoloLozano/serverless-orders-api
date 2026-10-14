import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';

interface EventOptions {
  method: string;
  routeKey?: string;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

/** Builds the API Gateway HTTP API (payload v2.0) event that Lambda receives. */
export function httpEvent(options: EventOptions): APIGatewayProxyEventV2 {
  const body =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return {
    version: '2.0',
    routeKey: options.routeKey ?? `${options.method} /test`,
    rawPath: '/test',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    pathParameters: options.pathParameters,
    queryStringParameters: options.queryStringParameters,
    body,
    isBase64Encoded: false,
    requestContext: {
      accountId: '123456789012',
      apiId: 'test-api',
      domainName: 'localhost',
      domainPrefix: 'localhost',
      http: {
        method: options.method,
        path: '/test',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: `req-${Math.random().toString(36).slice(2)}`,
      routeKey: options.routeKey ?? `${options.method} /test`,
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
  };
}

export const lambdaContext = {
  callbackWaitsForEmptyEventLoop: true,
  functionName: 'orders-api-test',
  functionVersion: '$LATEST',
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:orders-api-test',
  memoryLimitInMB: '512',
  awsRequestId: 'test-request',
  logGroupName: '/aws/lambda/orders-api-test',
  logStreamName: 'test',
  getRemainingTimeInMillis: () => 10_000,
  done: () => undefined,
  fail: () => undefined,
  succeed: () => undefined,
} satisfies Context;

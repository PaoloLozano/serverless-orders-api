import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { NoopCache, type Cache } from './cache/cache';
import { createRedisClient, RedisCache } from './cache/redis-cache';
import { loadConfig, type AppConfig } from './lib/config';
import { logger, metrics } from './lib/observability';
import { DynamoDbOrderRepository } from './repositories/dynamodb-order-repository';
import { OrderService } from './services/order-service';

export interface Dependencies {
  orderService: OrderService;
  close(): Promise<void>;
}

/** Composition root: the only place that knows which concrete implementations are used. */
export function createDependencies(config: AppConfig): Dependencies {
  // In AWS the SDK takes region and credentials from the Lambda environment. Locally,
  // DynamoDB Local accepts any credentials, so fixed dummy values are used.
  const localDynamoDb = config.dynamoDbEndpoint
    ? {
        endpoint: config.dynamoDbEndpoint,
        region: process.env.AWS_REGION ?? 'us-east-1',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      }
    : {};
  const dynamoDb = DynamoDBDocumentClient.from(new DynamoDBClient(localDynamoDb), {
    marshallOptions: { removeUndefinedValues: true },
  });

  const cache: Cache = config.cache
    ? new RedisCache(
        createRedisClient(config.cache, (error) =>
          logger.warn('Cache connection error', { error: error.message }),
        ),
      )
    : new NoopCache();

  const orderService = new OrderService({
    repository: new DynamoDbOrderRepository(dynamoDb, config.tableName),
    cache,
    cacheTtlSeconds: config.cacheTtlSeconds,
    logger,
    metrics,
  });

  return {
    orderService,
    async close() {
      await cache.close();
      dynamoDb.destroy();
    },
  };
}

let dependencies: Dependencies | undefined;

/**
 * Built once per Lambda execution environment and reused by every warm invocation, so
 * the DynamoDB HTTP connections and the Valkey TCP connection are not re-opened per request.
 */
export function getDependencies(): Dependencies {
  dependencies ??= createDependencies(loadConfig());
  return dependencies;
}

/** Test hook: replace (or reset with `undefined`) the shared dependencies. */
export function setDependencies(next: Dependencies | undefined): void {
  dependencies = next;
}

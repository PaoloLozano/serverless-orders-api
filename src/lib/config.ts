import type { RedisConnectionConfig } from '../cache/redis-cache';

export interface AppConfig {
  tableName: string;
  /** Only set for local development (DynamoDB Local). Empty in AWS. */
  dynamoDbEndpoint?: string;
  /** Undefined when the stack is deployed without a cache (EnableCache=false). */
  cache?: RedisConnectionConfig;
  cacheTtlSeconds: number;
}

function parsePositiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

/** Reads configuration from environment variables set in template.yaml. Fails fast on bad config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const tableName = env.TABLE_NAME?.trim();
  if (!tableName) {
    throw new Error('TABLE_NAME environment variable is required');
  }

  const cacheHost = env.CACHE_ENDPOINT?.trim();

  return {
    tableName,
    dynamoDbEndpoint: env.DYNAMODB_ENDPOINT?.trim() || undefined,
    cache: cacheHost
      ? {
          host: cacheHost,
          port: parsePositiveInt('CACHE_PORT', env.CACHE_PORT, 6379),
          // Secure by default: TLS is only disabled explicitly, for the local container.
          tls: env.CACHE_TLS !== 'false',
          clusterMode: env.CACHE_CLUSTER_MODE === 'true',
        }
      : undefined,
    cacheTtlSeconds: parsePositiveInt('CACHE_TTL_SECONDS', env.CACHE_TTL_SECONDS, 300),
  };
}

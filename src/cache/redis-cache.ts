import { Cluster, Redis, type RedisOptions } from 'ioredis';
import type { Cache } from './cache';

export interface RedisConnectionConfig {
  host: string;
  port: number;
  tls: boolean;
  /** ElastiCache Serverless speaks the Redis Cluster protocol, so production uses cluster mode. */
  clusterMode: boolean;
}

type RedisClient = Redis | Cluster;

/**
 * Timeouts are deliberately short: a slow cache must never make the API slow. If Valkey
 * does not answer quickly, the command fails and the service falls back to DynamoDB.
 */
export function createRedisClient(
  config: RedisConnectionConfig,
  onError: (error: Error) => void,
): RedisClient {
  const options: RedisOptions = {
    tls: config.tls ? {} : undefined,
    connectTimeout: 1_000,
    commandTimeout: 300,
    maxRetriesPerRequest: 1,
    // Connect on the first command instead of at import time.
    lazyConnect: true,
  };

  const client: RedisClient = config.clusterMode
    ? new Cluster([{ host: config.host, port: config.port }], {
        // Keep the hostname (instead of the resolved IP) so the TLS certificate matches.
        dnsLookup: (address, callback) => callback(null, address),
        redisOptions: options,
        lazyConnect: true,
        slotsRefreshTimeout: 2_000,
      })
    : new Redis({ host: config.host, port: config.port, ...options });

  // Without a listener, ioredis prints "Unhandled error event" on connection problems.
  client.on('error', onError);
  return client;
}

export class RedisCache implements Cache {
  constructor(private readonly client: RedisClient) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    // EX = expire after N seconds. Every entry has a TTL, so stale data is always bounded.
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

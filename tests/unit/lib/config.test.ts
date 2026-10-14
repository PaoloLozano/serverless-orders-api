import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/lib/config';

describe('loadConfig', () => {
  it('requires TABLE_NAME', () => {
    expect(() => loadConfig({})).toThrow('TABLE_NAME');
  });

  it('runs without a cache when CACHE_ENDPOINT is empty', () => {
    const config = loadConfig({ TABLE_NAME: 'orders', CACHE_ENDPOINT: '', DYNAMODB_ENDPOINT: '' });
    expect(config).toEqual({
      tableName: 'orders',
      dynamoDbEndpoint: undefined,
      cache: undefined,
      cacheTtlSeconds: 300,
    });
  });

  it('enables TLS by default and parses cache settings', () => {
    const config = loadConfig({
      TABLE_NAME: 'orders',
      CACHE_ENDPOINT: 'my-cache.serverless.use1.cache.amazonaws.com',
      CACHE_PORT: '6379',
      CACHE_CLUSTER_MODE: 'true',
      CACHE_TTL_SECONDS: '120',
    });
    expect(config.cache).toEqual({
      host: 'my-cache.serverless.use1.cache.amazonaws.com',
      port: 6379,
      tls: true,
      clusterMode: true,
    });
    expect(config.cacheTtlSeconds).toBe(120);
  });

  it('fails fast on invalid numbers', () => {
    expect(() => loadConfig({ TABLE_NAME: 'orders', CACHE_TTL_SECONDS: '-5' })).toThrow(
      'CACHE_TTL_SECONDS',
    );
  });
});

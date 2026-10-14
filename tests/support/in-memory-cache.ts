import type { Cache } from '../../src/cache/cache';

/** Test double for the cache port: a Map that also records the TTL of every entry. */
export class InMemoryCache implements Cache {
  readonly entries = new Map<string, { value: string; ttlSeconds: number }>();

  async get(key: string): Promise<string | null> {
    return this.entries.get(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, ttlSeconds });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async close(): Promise<void> {}
}

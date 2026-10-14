/**
 * Minimal cache port. The service only needs get / set-with-TTL / delete, which keeps
 * the cache-aside logic independent of the concrete store (Valkey/Redis, in-memory fake).
 */
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}

/** Used when the stack is deployed with EnableCache=false: every read is a miss. */
export class NoopCache implements Cache {
  async get(): Promise<string | null> {
    return null;
  }

  async set(): Promise<void> {}

  async delete(): Promise<void> {}

  async close(): Promise<void> {}
}

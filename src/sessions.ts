import type { SessionRow, Store } from './store/types.js';

/**
 * Session rows by id, cached: voice only needs columns that never change (org, kind, mode).
 * A miss isn't cached, so a session created after the first lookup is found next time.
 */
export function sessionCache(store: Store, max = 1000) {
  const cache = new Map<string, SessionRow>();
  return {
    async get(id: string): Promise<SessionRow | null> {
      const hit = cache.get(id);
      if (hit) return hit;
      const row = await store.getSession(id);
      if (row) {
        if (cache.size >= max) cache.delete(cache.keys().next().value!);
        cache.set(id, row);
      }
      return row;
    },
  };
}

export type SessionCache = ReturnType<typeof sessionCache>;

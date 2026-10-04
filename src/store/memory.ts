import type { SessionRow, Store } from './types.js';

export type MemoryData = { sessions: SessionRow[] };

/** In-memory store for tests and `pnpm dev:mock`; `data` is exposed for assertions. */
export function memoryStore(seed: Partial<MemoryData> = {}): Store & { data: MemoryData } {
  const data: MemoryData = { sessions: [...(seed.sessions ?? [])] };
  return {
    data,
    async getSession(id) {
      return data.sessions.find((s) => s.id === id) ?? null;
    },
  };
}

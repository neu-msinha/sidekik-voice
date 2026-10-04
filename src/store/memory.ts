import type { OffRecordSpan, SessionRow, Store, TranscriptTurnRow } from './types.js';

export type MemoryData = {
  sessions: SessionRow[];
  turns: TranscriptTurnRow[];
  offRecord: (OffRecordSpan & { session_id: string })[];
};

/** In-memory store for tests and `pnpm dev:mock`; `data` is exposed for assertions. */
export function memoryStore(seed: Partial<MemoryData> = {}): Store & { data: MemoryData } {
  const data: MemoryData = {
    sessions: [...(seed.sessions ?? [])],
    turns: [...(seed.turns ?? [])],
    offRecord: [...(seed.offRecord ?? [])],
  };
  return {
    data,
    async getSession(id) {
      return data.sessions.find((s) => s.id === id) ?? null;
    },
    async insertTurns(rows) {
      for (const row of rows) {
        if (data.turns.some((t) => t.session_id === row.session_id && t.turn_id === row.turn_id)) continue;
        data.turns.push({ ...row });
      }
    },
    async listTurns(sessionId) {
      return data.turns.filter((t) => t.session_id === sessionId).sort((a, b) => a.t_ms - b.t_ms);
    },
    async updateTurn(sessionId, turnId, patch) {
      const turn = data.turns.find((t) => t.session_id === sessionId && t.turn_id === turnId);
      if (turn) Object.assign(turn, patch);
    },
    async listOffRecordSpans(sessionId) {
      return data.offRecord
        .filter((s) => s.session_id === sessionId)
        .map(({ start_t_ms, end_t_ms }) => ({ start_t_ms, end_t_ms }));
    },
  };
}

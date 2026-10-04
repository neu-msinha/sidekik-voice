import type { OffRecordSpan, TranscriptTurnRow } from './store/types.js';

/** A webhook turn must land within this much of a stored turn to be the same turn (DESIGN §4). */
export const MATCH_WINDOW_MS = 1500;
/** …and have at least this much word overlap with it. */
export const MIN_SIMILARITY = 0.5;

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .normalize('NFKC')
      .split(/[^\p{L}\p{N}<>_]+/u)
      .filter(Boolean),
  );

/** Word-set overlap (Jaccard), 0–1. Redaction placeholders such as `<PERSON>` count as words. */
export function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

export function inOffRecord(tMs: number, spans: OffRecordSpan[]): boolean {
  return spans.some((s) => tMs >= s.start_t_ms && (s.end_t_ms === null || tMs <= s.end_t_ms));
}

export type WebhookTurn = { turn_id: string; role: 'user' | 'agent'; text: string; t_ms: number };

/**
 * The stored turn a webhook turn reconciles with: same role, within ±1.5 s, similar text; the
 * closest in time wins. `taken` holds turn ids already matched in this webhook, so two webhook
 * turns never claim the same stored turn.
 */
export function findMatch(turn: WebhookTurn, stored: TranscriptTurnRow[], taken: Set<string>): TranscriptTurnRow | undefined {
  let best: TranscriptTurnRow | undefined;
  for (const row of stored) {
    if (taken.has(row.turn_id) || row.role !== turn.role) continue;
    const gap = Math.abs(row.t_ms - turn.t_ms);
    if (gap > MATCH_WINDOW_MS || similarity(row.text_redacted, turn.text) < MIN_SIMILARITY) continue;
    if (!best || gap < Math.abs(best.t_ms - turn.t_ms)) best = row;
  }
  return best;
}

import type { SessionKind, SessionMode } from '../contracts/index.js';

/** The `sessions` columns voice reads (owned by gateway). */
export type SessionRow = {
  id: string;
  org_id: string;
  workflow_id: string;
  kind: SessionKind;
  mode: SessionMode;
  language: string;
  started_at: string;
  ended_at: string | null;
};

/** A `transcript_turns` row (SCHEMA.md 0002, owned by voice). */
export type TranscriptTurnRow = {
  org_id: string;
  session_id: string;
  turn_id: string;
  role: 'user' | 'agent';
  text_redacted: string;
  lang: string | null;
  t_ms: number;
  source: 'live' | 'webhook';
  off_record: boolean;
};

export type TurnPatch = Partial<Pick<TranscriptTurnRow, 'text_redacted' | 'lang' | 'source'>>;

/** An `off_record_spans` row (owned by gateway); `end_t_ms` is null while the span is open. */
export type OffRecordSpan = { start_t_ms: number; end_t_ms: number | null };

export interface Store {
  getSession(id: string): Promise<SessionRow | null>;
  /** Inserts the turns; a `(session_id, turn_id)` that already exists is left as it is. */
  insertTurns(rows: TranscriptTurnRow[]): Promise<void>;
  /** The session's turns, oldest first. */
  listTurns(sessionId: string): Promise<TranscriptTurnRow[]>;
  updateTurn(sessionId: string, turnId: string, patch: TurnPatch): Promise<void>;
  listOffRecordSpans(sessionId: string): Promise<OffRecordSpan[]>;
}

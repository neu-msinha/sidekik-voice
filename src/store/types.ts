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

/** An `agent_configs` row (SCHEMA.md 0002, owned by voice): what one Work Map version put on the Tutor agent. */
export type AgentConfigRow = {
  org_id: string;
  workmap_id: string;
  version: number;
  el_agent_id: string;
  kb_doc_id: string | null;
  /** `{step_id: procedure_id, "intervention": procedure_id}` */
  procedure_ids: Record<string, string>;
};

export type AgentConfigPatch = Partial<Pick<AgentConfigRow, 'kb_doc_id' | 'procedure_ids'>>;

export interface Store {
  getSession(id: string): Promise<SessionRow | null>;
  /** Inserts the turns; a `(session_id, turn_id)` that already exists is left as it is. */
  insertTurns(rows: TranscriptTurnRow[]): Promise<void>;
  /** The session's turns, oldest first. */
  listTurns(sessionId: string): Promise<TranscriptTurnRow[]>;
  updateTurn(sessionId: string, turnId: string, patch: TurnPatch): Promise<void>;
  listOffRecordSpans(sessionId: string): Promise<OffRecordSpan[]>;

  /** A file in the `workmaps` Storage bucket (written by mapper), or null if it isn't there. */
  readWorkmapFile(path: string): Promise<string | null>;
  getAgentConfig(workmapId: string, version: number): Promise<AgentConfigRow | null>;
  insertAgentConfig(row: AgentConfigRow): Promise<void>;
  updateAgentConfig(workmapId: string, version: number, patch: AgentConfigPatch): Promise<void>;
  /** Every `agent_configs` row for the workflow's Work Maps (any version). */
  listWorkflowAgentConfigs(workflowId: string): Promise<AgentConfigRow[]>;
}

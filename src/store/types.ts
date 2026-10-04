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

export interface Store {
  getSession(id: string): Promise<SessionRow | null>;
}

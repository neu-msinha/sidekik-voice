import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { OffRecordSpan, SessionRow, Store, TranscriptTurnRow } from './types.js';

const SESSION_COLUMNS = 'id, org_id, workflow_id, kind, mode, language, started_at, ended_at';
const TURN_COLUMNS = 'org_id, session_id, turn_id, role, text_redacted, lang, t_ms, source, off_record';

export function unwrap<T>({ data, error }: { data: T; error: PostgrestError | null }, what: string): T {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

/** Reads any table; writes only `transcript_turns` and `agent_configs` (ARCHITECTURE §6). */
export function supabaseStore(db: SupabaseClient): Store {
  return {
    async getSession(id) {
      return unwrap(
        await db.from('sessions').select(SESSION_COLUMNS).eq('id', id).maybeSingle<SessionRow>(),
        'get session',
      );
    },

    async insertTurns(rows) {
      if (rows.length === 0) return;
      unwrap(
        await db.from('transcript_turns').upsert(rows, { onConflict: 'session_id,turn_id', ignoreDuplicates: true }),
        'insert transcript turns',
      );
    },

    async listTurns(sessionId) {
      const rows = unwrap(
        await db
          .from('transcript_turns')
          .select(TURN_COLUMNS)
          .eq('session_id', sessionId)
          .order('t_ms', { ascending: true })
          .returns<TranscriptTurnRow[]>(),
        'list transcript turns',
      );
      return rows ?? [];
    },

    async updateTurn(sessionId, turnId, patch) {
      unwrap(
        await db.from('transcript_turns').update(patch).eq('session_id', sessionId).eq('turn_id', turnId),
        'update transcript turn',
      );
    },

    async listOffRecordSpans(sessionId) {
      const spans = unwrap(
        await db
          .from('off_record_spans')
          .select('start_t_ms, end_t_ms')
          .eq('session_id', sessionId)
          .returns<OffRecordSpan[]>(),
        'list off-record spans',
      );
      return spans ?? [];
    },
  };
}

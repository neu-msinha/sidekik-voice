import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { SessionRow, Store } from './types.js';

const SESSION_COLUMNS = 'id, org_id, workflow_id, kind, mode, language, started_at, ended_at';

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
  };
}

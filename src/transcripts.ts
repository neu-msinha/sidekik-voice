import type { FastifyBaseLogger } from 'fastify';
import type { Envelope, TranscriptTurn } from './contracts/index.js';
import type { SessionCache } from './sessions.js';
import type { Store } from './store/types.js';

export type TranscriptDeps = { store: Store; sessions: SessionCache; log: FastifyBaseLogger };

/**
 * `sk:transcript.turns` → `transcript_turns` with `source = "live"` (DESIGN §4). The gateway has
 * already redacted the text and dropped off-record turns. Idempotent: the bus skips handled event
 * ids, and a turn already stored for the session (same `turn_id`) is left as it is.
 */
export function transcriptHandler({ store, sessions, log }: TranscriptDeps) {
  return async (ev: Envelope<TranscriptTurn>): Promise<void> => {
    const started = Date.now();
    const ctx = { session_id: ev.session_id, org_id: ev.org_id, event_id: ev.id, turn_id: ev.data.turn_id };
    const session = await sessions.get(ev.session_id);
    if (!session) {
      log.warn(ctx, 'turn for an unknown session, skipped');
      return;
    }
    if (session.mode === 'replay') return;

    await store.insertTurns([
      {
        org_id: session.org_id,
        session_id: session.id,
        turn_id: ev.data.turn_id,
        role: ev.data.role,
        text_redacted: ev.data.text,
        lang: ev.data.lang,
        t_ms: ev.t_ms,
        source: 'live',
        off_record: false,
      },
    ]);
    log.debug({ ...ctx, latency_ms: Date.now() - started }, 'turn stored');
  };
}

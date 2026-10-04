import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { EVENT_TYPES, makeEvent, priceUsd, STREAMS, type Bus } from './contracts/index.js';
import type { GatewayClient } from './gateway.js';
import { findMatch, inOffRecord, type WebhookTurn } from './reconcile.js';
import type { SessionCache } from './sessions.js';
import type { SessionRow, Store, TranscriptTurnRow } from './store/types.js';

export const SIGNATURE_HEADER = 'elevenlabs-signature';
/** ElevenLabs' SDK accepts signatures up to 30 minutes old; a little clock skew is allowed the other way. */
const MAX_AGE_S = 30 * 60;
const MAX_SKEW_S = 5 * 60;

/**
 * `elevenlabs-signature: t=<unix>,v0=<hex>` where hex = HMAC-SHA256(secret, `${t}.${rawBody}`)
 * (the scheme of `webhooks.constructEvent` in @elevenlabs/elevenlabs-js).
 */
export function verifySignature(rawBody: string, header: string | undefined, secret: string, nowS = Date.now() / 1000): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || t < nowS - MAX_AGE_S || t > nowS + MAX_SKEW_S || !parts.v0) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(parts.v0.toLowerCase());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The parts of ElevenLabs' `post_call_transcription` payload voice reads (GetConversationResponseModel). */
const TranscriptionSchema = z.object({
  type: z.literal('post_call_transcription'),
  data: z.object({
    agent_id: z.string(),
    conversation_id: z.string().min(1),
    transcript: z
      .array(
        z.object({
          role: z.enum(['user', 'agent']),
          message: z.string().nullish(),
          time_in_call_secs: z.number().nonnegative(),
        }),
      )
      .default([]),
    metadata: z
      .object({ start_time_unix_secs: z.number().optional(), call_duration_secs: z.number().nonnegative().optional() })
      .default({}),
    conversation_initiation_client_data: z
      .object({ dynamic_variables: z.record(z.string(), z.unknown()).nullish() })
      .nullish(),
  }),
});
export type PostCallTranscription = z.infer<typeof TranscriptionSchema>;

export type PostCallDeps = { store: Store; bus: Bus; gateway: GatewayClient; sessions: SessionCache };

export type PostCallResult =
  | { status: 'ignored'; reason: string }
  | { status: 'done'; matched: number; inserted: number; off_record: number; failed: number };

/**
 * Reconciles the conversation's transcript with the live turns (DESIGN §4): every turn is placed
 * on the session timeline, dropped if it falls inside an off-record span, redacted through the
 * gateway (webhook text arrives unredacted), then either replaces the text of the live turn it
 * matches (keeping its `turn_id`, which evidence points at) or is inserted as `el:{conversation}:{n}`.
 * Safe to repeat: a turn already reconciled matches itself. Usage is published once per conversation.
 */
export async function handleTranscription(payload: PostCallTranscription, deps: PostCallDeps, log: FastifyBaseLogger): Promise<PostCallResult> {
  const { data } = payload;
  const sessionId = data.conversation_initiation_client_data?.dynamic_variables?.session_id;
  if (typeof sessionId !== 'string' || !sessionId) return { status: 'ignored', reason: 'no session_id dynamic variable' };
  const session = await deps.sessions.get(sessionId);
  if (!session) return { status: 'ignored', reason: 'unknown session' };
  if (session.mode === 'replay') return { status: 'ignored', reason: 'replay session' };

  const offset = conversationOffsetMs(session, data.metadata.start_time_unix_secs);
  const [stored, spans] = await Promise.all([deps.store.listTurns(session.id), deps.store.listOffRecordSpans(session.id)]);
  const taken = new Set<string>();
  const inserts: TranscriptTurnRow[] = [];
  const result = { status: 'done' as const, matched: 0, inserted: 0, off_record: 0, failed: 0 };

  for (const [n, item] of data.transcript.entries()) {
    const text = item.message?.trim();
    if (!text) continue;
    const tMs = Math.max(0, Math.round(offset + item.time_in_call_secs * 1000));
    if (inOffRecord(tMs, spans)) {
      result.off_record++;
      continue;
    }
    let redacted: string;
    try {
      redacted = await deps.gateway.redact(text, session.language);
    } catch (err) {
      // Never store unredacted text: the turn is skipped and the webhook answers 503 so it's retried.
      result.failed++;
      log.warn({ err, turn: n }, 'webhook turn not redacted, skipped');
      continue;
    }
    const turn: WebhookTurn = { turn_id: `el:${data.conversation_id}:${n}`, role: item.role, text: redacted, t_ms: tMs };
    const match = findMatch(turn, stored, taken);
    if (match) {
      taken.add(match.turn_id);
      if (match.source !== 'webhook' || match.text_redacted !== redacted) {
        await deps.store.updateTurn(session.id, match.turn_id, { text_redacted: redacted, source: 'webhook' });
      }
      result.matched++;
    } else {
      inserts.push({
        org_id: session.org_id,
        session_id: session.id,
        turn_id: turn.turn_id,
        role: turn.role,
        text_redacted: redacted,
        lang: session.language,
        t_ms: tMs,
        source: 'webhook',
        off_record: false,
      });
    }
  }
  await deps.store.insertTurns(inserts);
  result.inserted = inserts.length;

  const seconds = data.metadata.call_duration_secs;
  if (seconds !== undefined) await publishUsage(deps.bus, session, data.conversation_id, seconds, offset, log);
  return result;
}

/** Where the conversation starts on the session timeline (the page starts it after the session). */
function conversationOffsetMs(session: SessionRow, startUnixS: number | undefined): number {
  if (startUnixS === undefined) return 0;
  return Math.max(0, startUnixS * 1000 - Date.parse(session.started_at));
}

async function publishUsage(bus: Bus, session: SessionRow, conversationId: string, seconds: number, offset: number, log: FastifyBaseLogger) {
  const minutes = seconds / 60;
  const cost = priceUsd('elevenlabs', 'agent', 'minutes', minutes);
  if (cost === undefined) log.warn({ minutes }, 'no ElevenLabs price in the contracts; usage costed at 0');
  await bus.publish(
    STREAMS.usage,
    makeEvent({
      // One record per conversation: a retried webhook reuses the id, and consumers skip handled ids.
      id: `usage-el-${conversationId}`,
      type: EVENT_TYPES[STREAMS.usage],
      org_id: session.org_id,
      session_id: session.id,
      t_ms: Math.round(offset + seconds * 1000),
      producer: 'voice',
      data: { service: 'voice', vendor: 'elevenlabs', units: minutes, unit: 'minutes', cost_usd: cost ?? 0 },
    }),
  );
}

export type WebhookRoutesOptions = PostCallDeps & { secret: string };

/** POST /elevenlabs/post-call (public, `hooks.sidekik.live`): ElevenLabs' post-call webhook. */
export const webhookRoutes: FastifyPluginAsync<WebhookRoutesOptions> = async (app, opts) => {
  // The signature covers the exact bytes, so this route keeps the raw body.
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.post('/elevenlabs/post-call', async (request, reply) => {
    const started = Date.now();
    const raw = typeof request.body === 'string' ? request.body : '';
    const header = request.headers[SIGNATURE_HEADER];
    if (!verifySignature(raw, Array.isArray(header) ? header[0] : header, opts.secret)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Bad or missing ElevenLabs signature' });
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return reply.code(400).send({ error: 'bad_request', message: 'Body is not JSON' });
    }
    const type = (json as { type?: unknown } | null)?.type;
    if (type !== 'post_call_transcription') {
      request.log.info({ type }, 'post-call webhook ignored');
      return reply.code(200).send({ status: 'ignored', reason: `type ${String(type)}` });
    }
    const parsed = TranscriptionSchema.safeParse(json);
    if (!parsed.success) {
      request.log.warn({ issues: parsed.error.issues.slice(0, 5) }, 'post-call transcription not understood');
      return reply.code(400).send({ error: 'bad_request', message: 'Unexpected post_call_transcription payload' });
    }

    const sid = parsed.data.data.conversation_initiation_client_data?.dynamic_variables?.session_id;
    const session = typeof sid === 'string' ? await opts.sessions.get(sid) : null;
    const log = request.log.child({
      session_id: sid,
      org_id: session?.org_id,
      conversation_id: parsed.data.data.conversation_id,
    });
    const result = await handleTranscription(parsed.data, opts, log);
    log.info({ ...result, latency_ms: Date.now() - started }, 'post-call transcript reconciled');
    return reply.code(result.status === 'done' && result.failed > 0 ? 503 : 200).send(result);
  });
};

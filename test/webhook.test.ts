import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { STREAMS } from '../src/contracts/index.js';
import { similarity } from '../src/reconcile.js';
import { memoryStore } from '../src/store/memory.js';
import type { TranscriptTurnRow } from '../src/store/types.js';
import { verifySignature } from '../src/webhook.js';
import { buildTestApp, fakeBus, fakeGateway, IDS, SECRETS, sessionRow, STARTED_AT } from './helpers.js';

const startUnix = Date.parse(STARTED_AT) / 1000 + 10; // the conversation starts 10 s into the session

function sign(raw: string, secret = SECRETS.webhook, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v0=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
}

function payload(transcript: { role: 'user' | 'agent'; message: string | null; time_in_call_secs: number }[], extra: Record<string, unknown> = {}) {
  return {
    type: 'post_call_transcription',
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      agent_id: 'agent_interviewer',
      conversation_id: 'conv_1',
      status: 'done',
      transcript,
      metadata: { start_time_unix_secs: startUnix, call_duration_secs: 90 },
      conversation_initiation_client_data: { dynamic_variables: { session_id: IDS.session, expert_name: 'Sabine' } },
      ...extra,
    },
  };
}

const live = (overrides: Partial<TranscriptTurnRow>): TranscriptTurnRow => ({
  org_id: IDS.org,
  session_id: IDS.session,
  turn_id: 'live-1',
  role: 'user',
  text_redacted: 'Die geht auf 0400, weil es Anlagevermögen ist.',
  lang: 'de',
  t_ms: 12_000,
  source: 'live',
  off_record: false,
  ...overrides,
});

async function setup(seed: { turns?: TranscriptTurnRow[]; offRecord?: { session_id: string; start_t_ms: number; end_t_ms: number | null }[] } = {}) {
  const store = memoryStore({ sessions: [sessionRow()], ...seed });
  const bus = fakeBus();
  const gateway = fakeGateway();
  const app = await buildTestApp({ store, bus, gateway });
  const post = (body: unknown, signature?: string) => {
    const raw = JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: '/elevenlabs/post-call',
      headers: { 'content-type': 'application/json', 'elevenlabs-signature': signature ?? sign(raw) },
      payload: raw,
    });
  };
  return { app, store, bus, gateway, post };
}

describe('verifySignature', () => {
  const raw = '{"a":1}';
  const now = 1_800_000_000;
  it('accepts ElevenLabs signatures and rejects tampering, old or future timestamps', () => {
    expect(verifySignature(raw, sign(raw, 's', now), 's', now)).toBe(true);
    expect(verifySignature('{"a":2}', sign(raw, 's', now), 's', now)).toBe(false);
    expect(verifySignature(raw, sign(raw, 'other', now), 's', now)).toBe(false);
    expect(verifySignature(raw, sign(raw, 's', now - 31 * 60), 's', now)).toBe(false);
    expect(verifySignature(raw, sign(raw, 's', now + 10 * 60), 's', now)).toBe(false);
    expect(verifySignature(raw, undefined, 's', now)).toBe(false);
    expect(verifySignature(raw, 'garbage', 's', now)).toBe(false);
  });
});

describe('similarity', () => {
  it('scores word overlap and ignores case and punctuation', () => {
    expect(similarity('Die geht auf 0400.', 'die geht auf 0400')).toBe(1);
    expect(similarity('Got it, thanks.', 'Warum 0400?')).toBe(0);
  });
});

describe('POST /elevenlabs/post-call', () => {
  it('rejects a bad signature', async () => {
    const { app, post, store } = await setup();
    const res = await post(payload([{ role: 'user', message: 'x', time_in_call_secs: 1 }]), 't=1,v0=00');
    expect(res.statusCode).toBe(401);
    expect(store.data.turns).toEqual([]);
    await app.close();
  });

  it('replaces the text of matching live turns and inserts the ones the page missed', async () => {
    const { app, post, store, gateway } = await setup({
      turns: [live({}), live({ turn_id: 'live-2', role: 'agent', text_redacted: 'Warum geht die auf 0400?', t_ms: 7_000 })],
    });
    const res = await post(
      payload([
        { role: 'agent', message: 'Warum geht die auf null-vierhundert?', time_in_call_secs: 0.3 }, // 3.3 s after live-2: not the same turn
        { role: 'user', message: 'Die geht auf 0400, weil es Anlagevermögen ist, sagt Sabine.', time_in_call_secs: 2.8 }, // live-1, 0.8 s apart
        { role: 'agent', message: null, time_in_call_secs: 5 },
        { role: 'agent', message: 'Got it, thanks.', time_in_call_secs: 6 },
      ]),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'done', matched: 1, inserted: 2, off_record: 0, failed: 0 });
    expect(gateway.calls.map((c) => c.lang)).toEqual(['de', 'de', 'de']);

    const byId = Object.fromEntries(store.data.turns.map((t) => [t.turn_id, t]));
    expect(byId['live-1']).toMatchObject({ source: 'webhook', text_redacted: 'Die geht auf 0400, weil es Anlagevermögen ist, sagt <PERSON>.', t_ms: 12_000 });
    expect(byId['live-2']).toMatchObject({ source: 'live' });
    expect(byId['el:conv_1:0']).toMatchObject({ role: 'agent', t_ms: 10_300, source: 'webhook' });
    expect(byId['el:conv_1:3']).toMatchObject({ role: 'agent', t_ms: 16_000, text_redacted: 'Got it, thanks.', org_id: IDS.org });
    await app.close();
  });

  it('drops turns inside off-record spans, open spans included', async () => {
    const { app, post, store, gateway } = await setup({
      offRecord: [
        { session_id: IDS.session, start_t_ms: 11_000, end_t_ms: 13_000 },
        { session_id: IDS.session, start_t_ms: 30_000, end_t_ms: null },
      ],
    });
    const res = await post(
      payload([
        { role: 'user', message: 'Off the record: the supplier is a mess.', time_in_call_secs: 2 },
        { role: 'user', message: 'Back on. Cost center 0400.', time_in_call_secs: 5 },
        { role: 'user', message: 'Never stored.', time_in_call_secs: 25 },
      ]),
    );
    expect(res.json()).toMatchObject({ inserted: 1, off_record: 2 });
    expect(store.data.turns.map((t) => t.text_redacted)).toEqual(['Back on. Cost center 0400.']);
    expect(gateway.calls).toHaveLength(1);
    await app.close();
  });

  it('stores nothing unredacted and answers 503 when redaction fails, then reconciles on retry', async () => {
    const { app, post, store, gateway } = await setup();
    const body = payload([{ role: 'user', message: 'Sabine says 0400.', time_in_call_secs: 1 }]);
    gateway.fail = new Error('presidio down');
    const failed = await post(body);
    expect(failed.statusCode).toBe(503);
    expect(store.data.turns).toEqual([]);

    gateway.fail = undefined;
    expect((await post(body)).json()).toMatchObject({ inserted: 1, failed: 0 });
    expect((await post(body)).json()).toMatchObject({ matched: 1, inserted: 0 });
    expect(store.data.turns).toHaveLength(1);
    await app.close();
  });

  it('publishes usage once per conversation at $0.08 a minute', async () => {
    const { app, post, bus } = await setup();
    const body = payload([{ role: 'user', message: 'Hallo', time_in_call_secs: 1 }]);
    await post(body);
    await post(body);
    const usage = bus.events(STREAMS.usage);
    expect(usage).toHaveLength(2);
    expect(new Set(usage.map((e) => e.id)).size).toBe(1);
    expect(usage[0]).toMatchObject({
      id: 'usage-el-conv_1',
      producer: 'voice',
      org_id: IDS.org,
      session_id: IDS.session,
      t_ms: 100_000,
      data: { service: 'voice', vendor: 'elevenlabs', units: 1.5, unit: 'minutes' },
    });
    expect((usage[0]?.data as { cost_usd: number }).cost_usd).toBeCloseTo(0.12, 10);
    await app.close();
  });

  it('ignores other event types, unknown sessions and replay sessions', async () => {
    const { app, post, store } = await setup();
    expect((await post({ type: 'post_call_audio', data: { conversation_id: 'c' } })).json()).toMatchObject({ status: 'ignored' });
    const unknown = payload([{ role: 'user', message: 'x', time_in_call_secs: 1 }], {
      conversation_initiation_client_data: { dynamic_variables: { session_id: 'nope' } },
    });
    expect((await post(unknown)).json()).toEqual({ status: 'ignored', reason: 'unknown session' });
    expect(store.data.turns).toEqual([]);
    await app.close();

    const replay = memoryStore({ sessions: [sessionRow({ mode: 'replay' })] });
    const app2 = await buildTestApp({ store: replay });
    const raw = JSON.stringify(payload([{ role: 'user', message: 'x', time_in_call_secs: 1 }]));
    const res = await app2.inject({
      method: 'POST',
      url: '/elevenlabs/post-call',
      headers: { 'content-type': 'application/json', 'elevenlabs-signature': sign(raw) },
      payload: raw,
    });
    expect(res.json()).toEqual({ status: 'ignored', reason: 'replay session' });
    await app2.close();
  });

  it('keeps JSON parsing for the other routes', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/internal/token', headers: { 'x-internal-token': SECRETS.internal }, payload: { agent: 'x' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

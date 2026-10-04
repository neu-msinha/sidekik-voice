import { afterEach, describe, expect, it } from 'vitest';
import { httpElevenLabsClient } from '../src/elevenlabs.js';
import { mockElevenLabs } from './el-mock.js';
import { buildTestApp, IDS, SECRETS } from './helpers.js';

const headers = { 'x-internal-token': SECRETS.internal };
const body = (overrides: Record<string, unknown> = {}) => ({
  agent: 'interviewer',
  phase: 'capture',
  session_id: IDS.session,
  dynamic_variables: { session_id: IDS.session, expert_name: 'Sabine', workflow_name: 'Supplier invoice coding' },
  language: 'de',
  ...overrides,
});

let mock: Awaited<ReturnType<typeof mockElevenLabs>> | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function setup(reply: { status?: number; body?: unknown; delayMs?: number } = {}) {
  mock = await mockElevenLabs({
    'GET /v1/convai/conversation/token': (req) => ({
      body: { token: `tok-for-${req.query.get('agent_id')}`, conversation_id: 'conv_1' },
      ...reply,
    }),
  });
  const el = httpElevenLabsClient({ apiKey: 'el-key', baseUrl: mock.url });
  return { app: await buildTestApp({ el }), mock };
}

describe('POST /internal/token', () => {
  it('mints a WebRTC token for the capture interviewer', async () => {
    const { app, mock } = await setup();
    const res = await app.inject({ method: 'POST', url: '/internal/token', headers, payload: body() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ conversation_token: 'tok-for-agent_interviewer', agent_id: 'agent_interviewer' });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.query.get('agent_id')).toBe('agent_interviewer');
    expect(mock.requests[0]?.headers['xi-api-key']).toBe('el-key');
    await app.close();
  });

  it('uses the debrief agent for the debrief phase and the tutor agent for tutoring', async () => {
    const { app } = await setup();
    const debrief = await app.inject({ method: 'POST', url: '/internal/token', headers, payload: body({ phase: 'debrief' }) });
    expect(debrief.json()).toEqual({ conversation_token: 'tok-for-agent_debrief', agent_id: 'agent_debrief' });
    const tutor = await app.inject({
      method: 'POST',
      url: '/internal/token',
      headers,
      payload: body({ agent: 'tutor', phase: 'tutoring', session_id: IDS.tutor, language: 'en' }),
    });
    expect(tutor.json()).toEqual({ conversation_token: 'tok-for-agent_tutor', agent_id: 'agent_tutor' });
    await app.close();
  });

  it('answers 502 when ElevenLabs fails and 504 when it is too slow', async () => {
    const failing = await setup({ status: 500, body: { detail: 'boom' } });
    const res = await failing.app.inject({ method: 'POST', url: '/internal/token', headers, payload: body() });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'elevenlabs_error' });
    await failing.app.close();
    await mock?.close();

    const slow = await setup({ delayMs: 600 });
    const timedOut = await slow.app.inject({ method: 'POST', url: '/internal/token', headers, payload: body() });
    expect(timedOut.statusCode).toBe(504);
    await slow.app.close();
  });

  it('rejects calls without the internal token and bad bodies', async () => {
    const { app, mock } = await setup();
    expect((await app.inject({ method: 'POST', url: '/internal/token', payload: body() })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/internal/token', headers, payload: body({ agent: 'narrator' }) })).statusCode,
    ).toBe(400);
    expect(mock.requests).toHaveLength(0);
    await app.close();
  });
});

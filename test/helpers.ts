import { buildApp, type AppDeps } from '../src/app.js';
import { streamEnvelopeSchema, type Bus, type Envelope, type StreamKey } from '../src/contracts/index.js';
import { loadEnv, type Env } from '../src/env.js';
import { memoryStore } from '../src/store/memory.js';
import type { SessionRow } from '../src/store/types.js';

export const IDS = {
  org: '00000000-0000-4000-8000-00000000a001',
  workflow: '00000000-0000-4000-8000-00000000b001',
  session: '00000000-0000-4000-8000-00000000d001',
  tutor: '00000000-0000-4000-8000-00000000d002',
};

export const STARTED_AT = '2026-10-04T10:00:00.000Z';

export function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: IDS.session,
    org_id: IDS.org,
    workflow_id: IDS.workflow,
    kind: 'capture',
    mode: 'browser',
    language: 'de',
    started_at: STARTED_AT,
    ended_at: null,
    ...overrides,
  };
}

export const seededStore = () =>
  memoryStore({ sessions: [sessionRow(), sessionRow({ id: IDS.tutor, kind: 'tutor', language: 'en' })] });

export const SECRETS = {
  internal: 'i'.repeat(64),
  tool: 't'.repeat(64),
  webhook: 'wsec_webhook-signing-key-for-tests-0001',
};

export const RAW_ENV: Record<string, string> = {
  PORT: '8085',
  LOG_LEVEL: 'silent',
  REDIS_URL: 'redis://localhost:6379',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SK_INTERNAL_TOKEN: SECRETS.internal,
  SK_TOOL_SECRET: SECRETS.tool,
  ELEVENLABS_API_KEY: 'el-key',
  EL_INTERVIEWER_AGENT_ID: 'agent_interviewer',
  EL_TUTOR_AGENT_ID: 'agent_tutor',
  EL_DEBRIEF_AGENT_ID: 'agent_debrief',
  EL_WEBHOOK_SECRET: SECRETS.webhook,
  GATEWAY_INTERNAL_URL: 'http://localhost:8080',
};

export const testEnv = (overrides: Record<string, string> = {}): Env => loadEnv({ ...RAW_ENV, ...overrides });

type Handler = (ev: Envelope<unknown>) => Promise<void>;

/** Records published events (validated like the real bus); `deliver` feeds a consumer. */
export function fakeBus() {
  const published: { stream: StreamKey; ev: Envelope<unknown> }[] = [];
  const handlers = new Map<StreamKey, Handler>();
  const bus: Bus & {
    published: typeof published;
    fail?: Error;
    deliver(stream: StreamKey, ev: Envelope<unknown>): Promise<void>;
    events(stream: StreamKey): Envelope<unknown>[];
  } = {
    published,
    async publish(stream, ev) {
      if (bus.fail) throw bus.fail;
      streamEnvelopeSchema(stream).parse(ev);
      published.push({ stream, ev });
      return `${published.length}-0`;
    },
    consume(stream, handler) {
      handlers.set(stream, handler as Handler);
      return () => handlers.delete(stream);
    },
    async deliver(stream, ev) {
      const handler = handlers.get(stream);
      if (!handler) throw new Error(`no consumer for ${stream}`);
      await handler(ev);
    },
    events: (stream) => published.filter((p) => p.stream === stream).map((p) => p.ev),
    async close() {},
  };
  return bus;
}

export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  return buildApp({
    env: testEnv(),
    store: seededStore(),
    bus: fakeBus(),
    healthChecks: {},
    logger: false,
    ...overrides,
  });
}

let seq = 0;

/** A bus envelope for `session` at `t_ms`. */
export function envelope<T>(type: string, data: T, overrides: Partial<Envelope<T>> = {}): Envelope<T> {
  return {
    id: `01JTESTEVENT${String(++seq).padStart(14, '0')}`,
    type,
    v: 1,
    org_id: IDS.org,
    session_id: IDS.session,
    t_ms: 0,
    ts: STARTED_AT,
    producer: 'gateway',
    data,
    ...overrides,
  };
}

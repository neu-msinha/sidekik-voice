// `pnpm dev:mock`: voice with no ElevenLabs account, no Supabase and no teammates' services.
// Redis comes from sidekik-platform's docker-compose.
import { buildApp } from '../app.js';
import { createBus } from '../contracts/index.js';
import { loadEnv } from '../env.js';
import { createServiceLogger } from '../logger.js';
import { redisHealth } from '../redis-health.js';
import { memoryStore } from '../store/memory.js';

export const MOCK = {
  org: '00000000-0000-4000-8000-00000000a001',
  workflow: '00000000-0000-4000-8000-00000000b001',
  // gateway's mock browser capture session.
  session: '00000000-0000-4000-8000-00000000d001',
};

const DEV_SECRET = 'dev-mock-secret-not-for-production-0000000000';
const env = loadEnv({
  REDIS_URL: 'redis://localhost:6379',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'unused-in-mock',
  SK_INTERNAL_TOKEN: DEV_SECRET,
  SK_TOOL_SECRET: DEV_SECRET,
  ELEVENLABS_API_KEY: 'unused-in-mock',
  EL_INTERVIEWER_AGENT_ID: 'agent_mock_interviewer',
  EL_TUTOR_AGENT_ID: 'agent_mock_tutor',
  EL_DEBRIEF_AGENT_ID: 'agent_mock_debrief',
  EL_WEBHOOK_SECRET: DEV_SECRET,
  GATEWAY_INTERNAL_URL: 'http://localhost:8080',
  LOG_LEVEL: 'info',
  ...process.env,
});
const log = createServiceLogger(env.LOG_LEVEL);
const bus = createBus(env.REDIS_URL, 'voice', { logger: log.child({ component: 'bus' }) });
const redis = redisHealth(env.REDIS_URL, log);

const store = memoryStore({
  sessions: [
    {
      id: MOCK.session,
      org_id: MOCK.org,
      workflow_id: MOCK.workflow,
      kind: 'capture',
      mode: 'browser',
      language: 'de',
      started_at: new Date().toISOString(),
      ended_at: null,
    },
  ],
});

const app = await buildApp({ env, store, bus, healthChecks: { redis: redis.check }, loggerInstance: log });
app.addHook('onClose', () => bus.close());
app.addHook('onClose', redis.close);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: '::', port: env.PORT });
app.log.info({ session_id: MOCK.session, internal_token: env.SK_INTERNAL_TOKEN }, 'mock voice ready');

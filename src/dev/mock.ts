// `pnpm dev:mock`: voice with no ElevenLabs account, no Supabase and no teammates' services.
// Redis comes from sidekik-platform's docker-compose.
import { buildApp } from '../app.js';
import { createBus } from '../contracts/index.js';
import type { ElevenLabsClient } from '../elevenlabs.js';
import type { GatewayClient } from '../gateway.js';
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

// ElevenLabs stand-in: logs what voice would send and answers with made-up ids.
let n = 0;
const el: ElevenLabsClient = {
  async conversationToken(agentId) {
    return { token: `mock-conversation-token-${agentId}-${++n}` };
  },
  async getAgent(agentId) {
    return { agent_id: agentId, branch_id: 'agtbranch_mock' };
  },
  async createAgent(body) {
    log.info({ name: body.name }, 'mock elevenlabs: agent created');
    return { agent_id: `agent_mock_${++n}` };
  },
  async updateAgent(agentId, body) {
    log.info({ agent_id: agentId, keys: Object.keys(body) }, 'mock elevenlabs: agent updated');
  },
  async createKnowledgeBaseText(name, text) {
    log.info({ name, chars: text.length }, 'mock elevenlabs: knowledge base document created');
    return { id: `kb_mock_${++n}`, name };
  },
  async deleteKnowledgeBaseDoc(id) {
    log.info({ kb_doc_id: id }, 'mock elevenlabs: knowledge base document deleted');
  },
  async createProcedure(agentId, _branchId, body) {
    log.info({ agent_id: agentId, name: body.name, type: body.type }, 'mock elevenlabs: procedure created');
    return { procedure_id: `proc_mock_${++n}` };
  },
  async listProcedures() {
    return [];
  },
  async deleteProcedure() {},
  async createWebhook(name) {
    return { webhook_id: `wh_mock_${name}`, webhook_secret: DEV_SECRET };
  },
};

// Gateway stand-in: "redacts" by masking digits, so the flow is visible without Presidio.
const gateway: GatewayClient = {
  async redact(text) {
    return text.replace(/\d/g, '#');
  },
};

const app = await buildApp({ env, store, bus, el, gateway, healthChecks: { redis: redis.check }, loggerInstance: log });
app.addHook('onClose', () => bus.close());
app.addHook('onClose', redis.close);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: '::', port: env.PORT });
app.log.info(
  {
    session_id: MOCK.session,
    internal_token: env.SK_INTERNAL_TOKEN,
    try: `curl -X POST localhost:${env.PORT}/internal/token -H 'x-internal-token: ${env.SK_INTERNAL_TOKEN}' -H 'content-type: application/json' -d '{"agent":"interviewer","phase":"capture","session_id":"${MOCK.session}","dynamic_variables":{},"language":"de"}'`,
  },
  'mock voice ready',
);

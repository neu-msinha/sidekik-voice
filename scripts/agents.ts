// Agents as code (DESIGN §3, tickets 1–2).
//
//   pnpm agents:push [--dry-run] [--only interviewer,tutor]
//       Composes each agent in agents/agents.json (config + prompt file + tools) and PATCHes it onto
//       the agent whose id is in its `id_env` variable. An agent without an id is created, and its
//       id is printed for .env and Railway. --dry-run prints the bodies (tool secret masked).
//   pnpm agents:webhook https://hooks.sidekik.live
//       Creates the workspace post-call webhook ({url}/elevenlabs/post-call, HMAC) and prints its id
//       and secret: set EL_POST_CALL_WEBHOOK_ID and EL_WEBHOOK_SECRET, then push again.
import { z } from 'zod';
import { composeAgent, readManifest } from '../src/agents/compose.js';
import { httpElevenLabsClient } from '../src/elevenlabs.js';

const [command, ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const env = z
  .object({
    ELEVENLABS_API_KEY: z.string().min(1),
    SK_TOOL_SECRET: z.string().min(32),
    TOOLS_BASE_URL: z.url().default('https://api.sidekik.live'),
    EL_POST_CALL_WEBHOOK_ID: z.string().min(1).optional(),
  })
  .parse({ ...process.env, ...(flag('dry-run') && { ELEVENLABS_API_KEY: 'dry-run', SK_TOOL_SECRET: process.env.SK_TOOL_SECRET || 'x'.repeat(32) }) });
const el = httpElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY, timeoutMs: 30_000 });

async function push() {
  const only = option('only')?.split(',');
  const created: string[] = [];
  for (const entry of readManifest()) {
    if (only && !only.includes(entry.key)) continue;
    const id = process.env[entry.id_env] || undefined;
    const vars = { toolsBaseUrl: env.TOOLS_BASE_URL, toolSecret: env.SK_TOOL_SECRET, postCallWebhookId: env.EL_POST_CALL_WEBHOOK_ID };

    if (flag('dry-run')) {
      const body = JSON.stringify(composeAgent(entry, vars), null, 2).replaceAll(env.SK_TOOL_SECRET, '<SK_TOOL_SECRET>');
      console.log(`# ${entry.key} → ${id ? `PATCH ${id}` : 'create'}\n${body}\n`);
      continue;
    }
    if (id) {
      // Keep the knowledge base kbsync attached (tutor), so a push never detaches the Work Map.
      const current = await el.getAgent(id);
      const kb = current.conversation_config?.agent?.prompt?.knowledge_base ?? undefined;
      await el.updateAgent(id, composeAgent(entry, vars, kb));
      console.log(`${entry.key}: pushed to ${id}`);
    } else {
      const { agent_id } = await el.createAgent(composeAgent(entry, vars));
      created.push(`${entry.id_env}=${agent_id}`);
      console.log(`${entry.key}: created ${agent_id}`);
    }
  }
  if (created.length) console.log(`\nAdd to .env and Railway:\n${created.join('\n')}`);
  if (!env.EL_POST_CALL_WEBHOOK_ID && !flag('dry-run')) {
    console.log('\nNo EL_POST_CALL_WEBHOOK_ID: run `pnpm agents:webhook <public url>` and push again to attach the post-call webhook.');
  }
}

async function webhook() {
  const base = args.find((a) => !a.startsWith('--'));
  if (!base) throw new Error('usage: pnpm agents:webhook https://hooks.sidekik.live');
  const url = `${base.replace(/\/$/, '')}/elevenlabs/post-call`;
  const { webhook_id, webhook_secret } = await el.createWebhook('sidekik-voice post-call', url);
  console.log(`Webhook for ${url}\nEL_POST_CALL_WEBHOOK_ID=${webhook_id}\nEL_WEBHOOK_SECRET=${webhook_secret}`);
}

const commands: Record<string, () => Promise<void>> = { push, webhook };
const run = command ? commands[command] : undefined;
if (!run) {
  console.error('usage: tsx scripts/agents.ts push [--dry-run] [--only a,b] | webhook <public url>');
  process.exit(2);
}
await run();

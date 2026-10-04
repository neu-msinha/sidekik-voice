import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeBaseLocator } from '../elevenlabs.js';

export const AGENTS_DIR = new URL('../../agents/', import.meta.url).pathname;

export type ManifestEntry = { key: string; config: string; prompt: string; tools: string[]; id_env: string };

export type ComposeVars = {
  /** Base URL of the public API the webhook tools call, e.g. https://api.sidekik.live. */
  toolsBaseUrl: string;
  /** Sent as `X-Sidekik-Tool-Secret` by every webhook tool. */
  toolSecret: string;
  /** Workspace post-call webhook to attach to the agent, if one exists yet. */
  postCallWebhookId?: string | undefined;
};

type Json = Record<string, any>;

export function readManifest(dir = AGENTS_DIR): ManifestEntry[] {
  return (JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')) as { agents: ManifestEntry[] }).agents;
}

/**
 * The PATCH body for one agent: its config file with the prompt file and its tools injected
 * (ticket 2). Tool files carry `{{TOOLS_BASE_URL}}` and `{{SK_TOOL_SECRET}}` placeholders; the
 * prompt's own `{{dynamic_variables}}` are left for ElevenLabs. `knowledgeBase` keeps the KB
 * documents kbsync attached, so a push never detaches the published Work Map.
 */
export function composeAgent(entry: ManifestEntry, vars: ComposeVars, knowledgeBase?: KnowledgeBaseLocator[], dir = AGENTS_DIR): Json {
  const config = JSON.parse(readFileSync(join(dir, entry.config), 'utf8')) as Json;
  const prompt = readFileSync(join(dir, entry.prompt), 'utf8').trim();
  const tools = entry.tools.map((name) => {
    const raw = readFileSync(join(dir, 'tools', `${name}.json`), 'utf8')
      .replaceAll('{{TOOLS_BASE_URL}}', vars.toolsBaseUrl.replace(/\/$/, ''))
      .replaceAll('{{SK_TOOL_SECRET}}', vars.toolSecret);
    return JSON.parse(raw) as Json;
  });

  const agentPrompt = (((config.conversation_config ??= {}).agent ??= {}).prompt ??= {});
  agentPrompt.prompt = prompt;
  agentPrompt.tools = tools;
  if (knowledgeBase?.length) agentPrompt.knowledge_base = knowledgeBase;
  if (vars.postCallWebhookId) {
    const settings = (config.platform_settings ??= {});
    settings.workspace_overrides = {
      ...settings.workspace_overrides,
      webhooks: { post_call_webhook_id: vars.postCallWebhookId, events: ['transcript'], send_audio: false },
    };
  }
  return config;
}

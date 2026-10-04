import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENTS_DIR, composeAgent, readManifest } from '../src/agents/compose.js';

const vars = { toolsBaseUrl: 'https://api.sidekik.live/', toolSecret: 's'.repeat(64) };
const entry = (key: string) => readManifest().find((e) => e.key === key)!;
const prompt = (body: Record<string, any>) => body.conversation_config.agent.prompt;

describe('agents as code', () => {
  it('defines the interviewer, its debrief configuration and the tutor', () => {
    expect(readManifest().map((e) => [e.key, e.id_env])).toEqual([
      ['interviewer', 'EL_INTERVIEWER_AGENT_ID'],
      ['interviewer-debrief', 'EL_DEBRIEF_AGENT_ID'],
      ['tutor', 'EL_TUTOR_AGENT_ID'],
    ]);
  });

  it('injects the prompt file, keeping its dynamic variables for ElevenLabs', () => {
    const body = composeAgent(entry('interviewer'), vars);
    expect(prompt(body).prompt).toMatch(/^You are Sidekik, an apprentice sitting next to \{\{expert_name\}\}/);
    expect(prompt(body).prompt).toContain('{{prior_summary}}');
    expect(prompt(composeAgent(entry('interviewer-debrief'), vars)).prompt).toContain('[SIDEKIK] TEACHBACK:');
  });

  it('injects the tools with the API base URL and the tool secret', () => {
    const tools = prompt(composeAgent(entry('tutor'), vars)).tools as Record<string, any>[];
    expect(tools.map((t) => `${t.type}:${t.name}`)).toEqual([
      'client:replay_moment',
      'client:highlight_field',
      'client:show_status',
      'webhook:check_guardrails',
      'webhook:get_step',
      'webhook:get_expert_moment',
    ]);
    const check = tools.find((t) => t.name === 'check_guardrails')!;
    expect(check.api_schema.url).toBe('https://api.sidekik.live/v1/tools/check_guardrails');
    expect(check.api_schema.request_headers).toEqual({ 'X-Sidekik-Tool-Secret': vars.toolSecret });
    expect(check.api_schema.request_body_schema.properties.session_id.dynamic_variable).toBe('session_id');
  });

  it('matches DESIGN §3 turn settings, overrides and auth', () => {
    const interviewer = composeAgent(entry('interviewer'), vars);
    expect(interviewer.conversation_config.turn).toEqual({ turn_eagerness: 'patient', turn_timeout: 20 });
    expect(Object.keys(prompt(interviewer).built_in_tools)).toEqual(['skip_turn', 'end_call', 'language_detection']);
    expect(composeAgent(entry('interviewer-debrief'), vars).conversation_config.turn.turn_eagerness).toBe('normal');
    const tutor = composeAgent(entry('tutor'), vars);
    expect(Object.keys(prompt(tutor).built_in_tools)).toEqual(['skip_turn', 'end_call']);
    for (const body of [interviewer, tutor]) {
      expect(prompt(body).llm).toBe('claude-haiku-4-5');
      expect(body.conversation_config.asr.provider).toBe('scribe_realtime');
      expect(body.platform_settings.auth).toEqual({ enable_auth: true });
      expect(body.platform_settings.overrides.conversation_config_override.agent).toEqual({
        first_message: true,
        language: true,
        prompt: { prompt: true },
      });
    }
  });

  it('keeps the knowledge base and attaches the post-call webhook when given', () => {
    const kb = [{ type: 'text' as const, name: 'workmap-x-v1.md', id: 'kb_1', usage_mode: 'auto' as const }];
    const body = composeAgent(entry('tutor'), { ...vars, postCallWebhookId: 'wh_1' }, kb);
    expect(prompt(body).knowledge_base).toEqual(kb);
    expect(body.platform_settings.workspace_overrides.webhooks).toEqual({
      post_call_webhook_id: 'wh_1',
      events: ['transcript'],
      send_audio: false,
    });
    expect(composeAgent(entry('tutor'), vars).platform_settings.workspace_overrides).toBeUndefined();
  });

  it('commits no secrets: tool files only carry placeholders', () => {
    const dir = join(AGENTS_DIR, 'tools');
    for (const file of readdirSync(dir)) {
      const raw = readFileSync(join(dir, file), 'utf8');
      if (raw.includes('request_headers')) expect(raw).toContain('{{SK_TOOL_SECRET}}');
    }
  });
});

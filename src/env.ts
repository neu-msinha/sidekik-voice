import { z } from 'zod';
import { BaseServiceEnvSchema, loadEnv as parseEnv } from './contracts/index.js';

// Shared secrets are generated with `openssl rand -hex 32` (64 hex chars).
const secret = z.string().min(32, 'must be at least 32 characters (openssl rand -hex 32)');
const url = z.url();

export const envSchema = BaseServiceEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(8085),
  SK_INTERNAL_TOKEN: secret,
  // Sent by the agents' webhook tools as `X-Sidekik-Tool-Secret` (shared with gateway + tutor).
  SK_TOOL_SECRET: secret,

  ELEVENLABS_API_KEY: z.string().min(1),
  EL_INTERVIEWER_AGENT_ID: z.string().min(1),
  EL_TUTOR_AGENT_ID: z.string().min(1),
  // The post-call webhook's HMAC secret, from the ElevenLabs webhook settings.
  EL_WEBHOOK_SECRET: z.string().min(1),

  // POST {GATEWAY_INTERNAL_URL}/internal/redact for webhook turns.
  GATEWAY_INTERNAL_URL: url,
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return parseEnv(envSchema, source);
}

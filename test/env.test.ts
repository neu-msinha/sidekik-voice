import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';
import { RAW_ENV } from './helpers.js';

describe('loadEnv', () => {
  it('parses a complete environment and defaults the port', () => {
    const { PORT: _port, ...rest } = RAW_ENV;
    const env = loadEnv(rest);
    expect(env.PORT).toBe(8085);
    expect(env.EL_TUTOR_AGENT_ID).toBe('agent_tutor');
  });

  it('lists every missing variable', () => {
    const { ELEVENLABS_API_KEY: _key, EL_WEBHOOK_SECRET: _secret, ...rest } = RAW_ENV;
    expect(() => loadEnv(rest)).toThrow(/ELEVENLABS_API_KEY[\s\S]*EL_WEBHOOK_SECRET|EL_WEBHOOK_SECRET[\s\S]*ELEVENLABS_API_KEY/);
  });

  it('rejects short shared secrets', () => {
    expect(() => loadEnv({ ...RAW_ENV, SK_TOOL_SECRET: 'short' })).toThrow(/SK_TOOL_SECRET/);
  });
});

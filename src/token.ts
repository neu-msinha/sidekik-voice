import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { internalAuth, VoiceTokenRequestSchema, VoiceTokenResponseSchema } from './contracts/index.js';
import type { ElevenLabsClient } from './elevenlabs.js';
import type { Env } from './env.js';
import type { SessionCache } from './sessions.js';

export type AgentIds = Pick<Env, 'EL_INTERVIEWER_AGENT_ID' | 'EL_DEBRIEF_AGENT_ID' | 'EL_TUTOR_AGENT_ID'>;

/**
 * The agent for a phase. ElevenLabs can't bind a prompt override to a WebRTC token, so the
 * debrief prompt lives in an agent of its own (README "Agents as code").
 */
export function agentFor(agent: 'interviewer' | 'tutor', phase: string, ids: AgentIds): string {
  if (agent === 'tutor') return ids.EL_TUTOR_AGENT_ID;
  return phase === 'debrief' ? ids.EL_DEBRIEF_AGENT_ID : ids.EL_INTERVIEWER_AGENT_ID;
}

export type TokenRoutesOptions = { el: ElevenLabsClient; ids: AgentIds; sessions: SessionCache; internalToken: string };

/**
 * POST /internal/token (gateway → voice, 500 ms): a WebRTC conversation token for the phase's
 * agent. The page starts the session with it and passes the gateway's dynamic variables.
 */
export const tokenRoutes: FastifyPluginAsyncZod<TokenRoutesOptions> = async (app, opts) => {
  app.addHook('onRequest', internalAuth(opts.internalToken));

  app.post(
    '/internal/token',
    { schema: { body: VoiceTokenRequestSchema, response: { 200: VoiceTokenResponseSchema } } },
    async (request) => {
      const started = Date.now();
      const { agent, phase, session_id } = request.body;
      const agent_id = agentFor(agent, phase, opts.ids);
      // The org is only for the log line, so a slow or failed lookup never delays the token.
      const org = opts.sessions.get(session_id).then(
        (s) => s?.org_id,
        () => undefined,
      );
      const { token } = await opts.el.conversationToken(agent_id);
      const org_id = await Promise.race([org, new Promise<undefined>((r) => setTimeout(r, 20))]);
      request.log.info(
        { session_id, org_id, agent, phase, agent_id, latency_ms: Date.now() - started },
        'conversation token minted',
      );
      return { conversation_token: token, agent_id };
    },
  );
};

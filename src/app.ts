import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { STREAMS, type Bus } from './contracts/index.js';
import type { ElevenLabsClient } from './elevenlabs.js';
import type { Env } from './env.js';
import type { GatewayClient } from './gateway.js';
import { HttpError } from './errors.js';
import { healthRoutes, type HealthCheck } from './routes/health.js';
import { kbSyncHandler } from './kbsync.js';
import { sessionCache } from './sessions.js';
import type { Store } from './store/types.js';
import { tokenRoutes } from './token.js';
import { transcriptHandler } from './transcripts.js';
import { webhookRoutes } from './webhook.js';
import { VERSION } from './version.js';

export type AppDeps = {
  env: Env;
  store: Store;
  bus: Bus;
  el: ElevenLabsClient;
  gateway: GatewayClient;
  healthChecks: Record<string, HealthCheck>;
  /** The service's shared pino logger (server, dev:mock); tests pass `logger` options instead. */
  loggerInstance?: FastifyBaseLogger;
  logger?: FastifyServerOptions['logger'];
};

export async function buildApp(deps: AppDeps) {
  const { env } = deps;
  const logger = deps.logger ?? { level: env.LOG_LEVEL };
  const app = Fastify({
    ...(deps.loggerInstance
      ? { loggerInstance: deps.loggerInstance }
      : {
          logger:
            typeof logger === 'object'
              ? { ...logger, base: { service: 'sidekik-voice', version: VERSION, pid: process.pid } }
              : logger,
        }),
    // Cloudflare → Railway: trust X-Forwarded-* for client IPs.
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler<FastifyError>((err, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Request validation failed',
        issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    }
    if (err instanceof HttpError) {
      if (err.statusCode >= 500) request.log.warn({ err }, err.message);
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(500).send({ error: 'internal_error', message: 'Internal Server Error' });
    }
    return reply.code(status).send({ error: err.code ?? 'error', message: err.message });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: 'not_found', message: `Route ${request.method} ${request.url} not found` }),
  );

  const sessions = sessionCache(deps.store);

  // Bus consumers start once the app is ready and stop when it closes.
  const stops: (() => void)[] = [];
  app.addHook('onReady', async () => {
    const log = app.log.child({ component: 'bus' });
    stops.push(
      deps.bus.consume(STREAMS.turns, transcriptHandler({ store: deps.store, sessions, log })),
      deps.bus.consume(STREAMS.workmapPublished, kbSyncHandler({ store: deps.store, el: deps.el, tutorAgentId: env.EL_TUTOR_AGENT_ID, log })),
    );
  });
  app.addHook('onClose', async () => {
    for (const stop of stops.splice(0)) stop();
  });

  await app.register(healthRoutes, { version: VERSION, checks: deps.healthChecks });
  await app.register(webhookRoutes, {
    store: deps.store,
    bus: deps.bus,
    gateway: deps.gateway,
    sessions,
    secret: env.EL_WEBHOOK_SECRET,
  });
  await app.register(tokenRoutes, { el: deps.el, ids: env, sessions, internalToken: env.SK_INTERNAL_TOKEN });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;

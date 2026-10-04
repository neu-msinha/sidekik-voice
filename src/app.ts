import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Bus } from './contracts/index.js';
import type { Env } from './env.js';
import { HttpError } from './errors.js';
import { healthRoutes, type HealthCheck } from './routes/health.js';
import type { Store } from './store/types.js';
import { VERSION } from './version.js';

export type AppDeps = {
  env: Env;
  store: Store;
  bus: Bus;
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

  await app.register(healthRoutes, { version: VERSION, checks: deps.healthChecks });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;

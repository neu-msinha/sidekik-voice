import { INTERNAL_TOKEN_HEADER, RedactResponseSchema } from './contracts/index.js';
import { HttpError } from './errors.js';

// Budget from ARCHITECTURE §4.3.
export const REDACT_BUDGET_MS = 300;

export interface GatewayClient {
  /** Presidio through gateway POST /internal/redact. Throws if the text couldn't be redacted. */
  redact(text: string, lang?: string): Promise<string>;
}

export function httpGatewayClient(baseUrl: string, internalToken: string): GatewayClient {
  return {
    async redact(text, lang) {
      let res: Response;
      try {
        res = await fetch(new URL('/internal/redact', baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json', [INTERNAL_TOKEN_HEADER]: internalToken },
          body: JSON.stringify({ text, ...(lang && { lang }) }),
          signal: AbortSignal.timeout(REDACT_BUDGET_MS),
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          throw new HttpError(504, 'gateway_timeout', `gateway /internal/redact timed out after ${REDACT_BUDGET_MS} ms`);
        }
        throw new HttpError(502, 'gateway_unreachable', 'gateway /internal/redact unreachable');
      }
      if (!res.ok) throw new HttpError(502, 'gateway_error', `gateway /internal/redact returned ${res.status}`);
      const parsed = RedactResponseSchema.safeParse(await res.json().catch(() => undefined));
      if (!parsed.success) throw new HttpError(502, 'gateway_bad_response', 'gateway /internal/redact returned an unexpected body');
      return parsed.data.text;
    },
  };
}

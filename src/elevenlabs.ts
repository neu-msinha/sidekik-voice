import { HttpError } from './errors.js';

/** The ElevenLabs Agents endpoints voice uses (checked against @elevenlabs/elevenlabs-js 2.70 and the docs). */
export interface ElevenLabsClient {
  /** GET /v1/convai/conversation/token: a WebRTC conversation token for a private agent. */
  conversationToken(agentId: string): Promise<{ token: string; conversation_id?: string }>;
  /** GET /v1/convai/agents/{id}. */
  getAgent(agentId: string): Promise<ElAgent>;
  /** POST /v1/convai/agents/create. */
  createAgent(body: Record<string, unknown>): Promise<{ agent_id: string }>;
  /** PATCH /v1/convai/agents/{id}. */
  updateAgent(agentId: string, body: Record<string, unknown>): Promise<void>;
  /** POST /v1/convai/knowledge-base/text. */
  createKnowledgeBaseText(name: string, text: string): Promise<{ id: string; name: string }>;
  /** DELETE /v1/convai/knowledge-base/{id}?force=true (also detaches it from agents). */
  deleteKnowledgeBaseDoc(id: string): Promise<void>;
  /** POST /v1/convai/agents/{id}/branches/{branch}/procedures. */
  createProcedure(agentId: string, branchId: string, body: ProcedureInput): Promise<{ procedure_id: string }>;
  /** GET /v1/convai/agents/{id}/branches/{branch}/procedures. */
  listProcedures(agentId: string, branchId: string): Promise<ElProcedure[]>;
  /** DELETE /v1/convai/agents/{id}/branches/{branch}/procedures/{procedure_id}. */
  deleteProcedure(agentId: string, branchId: string, procedureId: string): Promise<void>;
  /** POST /v1/workspace/webhooks: an HMAC webhook; the secret is only returned here. */
  createWebhook(name: string, url: string): Promise<{ webhook_id: string; webhook_secret: string }>;
}

export type KnowledgeBaseLocator = { type: 'file' | 'url' | 'text' | 'folder'; name: string; id: string; usage_mode?: 'prompt' | 'auto' };

export type ElAgent = {
  agent_id: string;
  name?: string;
  branch_id?: string | null;
  conversation_config?: {
    agent?: { prompt?: { knowledge_base?: KnowledgeBaseLocator[] | null; [k: string]: unknown } | null; [k: string]: unknown };
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

export type ProcedureInput = { name: string; content: string; type: 'free_form' | 'deterministic' };
export type ElProcedure = { procedure_id: string; version_id?: string | null; name?: string; type?: string };

export const EL_API_URL = 'https://api.elevenlabs.io';

export function httpElevenLabsClient(opts: { apiKey: string; baseUrl?: string; timeoutMs?: number }): ElevenLabsClient {
  const base = opts.baseUrl ?? EL_API_URL;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function call<T>(method: string, path: string, body?: unknown, timeout = timeoutMs): Promise<T> {
    let res: Response;
    try {
      res = await fetch(new URL(path, base), {
        method,
        headers: { 'xi-api-key': opts.apiKey, ...(body !== undefined && { 'content-type': 'application/json' }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new HttpError(504, 'elevenlabs_timeout', `ElevenLabs ${method} ${path} timed out after ${timeout} ms`);
      }
      throw new HttpError(502, 'elevenlabs_unreachable', `ElevenLabs ${method} ${path} unreachable`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new HttpError(502, 'elevenlabs_error', `ElevenLabs ${method} ${path} returned ${res.status}: ${detail}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json().catch(() => undefined)) as T;
  }

  const agentPath = (id: string) => `/v1/convai/agents/${encodeURIComponent(id)}`;
  const procPath = (id: string, branch: string) => `${agentPath(id)}/branches/${encodeURIComponent(branch)}/procedures`;

  return {
    // The gateway gives voice 500 ms for /internal/token, so the token call gets 450.
    conversationToken: (agentId) =>
      call('GET', `/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`, undefined, 450),
    getAgent: (agentId) => call('GET', agentPath(agentId)),
    createAgent: (body) => call('POST', '/v1/convai/agents/create', body),
    updateAgent: async (agentId, body) => {
      await call('PATCH', agentPath(agentId), body);
    },
    createKnowledgeBaseText: (name, text) => call('POST', '/v1/convai/knowledge-base/text', { name, text }),
    deleteKnowledgeBaseDoc: async (id) => {
      await call('DELETE', `/v1/convai/knowledge-base/${encodeURIComponent(id)}?force=true`);
    },
    createProcedure: (agentId, branchId, body) => call('POST', procPath(agentId, branchId), body),
    listProcedures: async (agentId, branchId) =>
      (await call<{ procedures?: ElProcedure[] }>('GET', procPath(agentId, branchId))).procedures ?? [],
    deleteProcedure: async (agentId, branchId, procedureId) => {
      await call('DELETE', `${procPath(agentId, branchId)}/${encodeURIComponent(procedureId)}`);
    },
    createWebhook: (name, url) =>
      call('POST', '/v1/workspace/webhooks', { settings: { auth_type: 'hmac', name, webhook_url: url } }),
  };
}

import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockRequest = { method: string; path: string; query: URLSearchParams; headers: IncomingMessage['headers']; body: any };
export type MockReply = { status?: number; body?: unknown; delayMs?: number };
type Route = (req: MockRequest) => MockReply | undefined;

/** A local stand-in for api.elevenlabs.io: records every request and answers from `routes`. */
export async function mockElevenLabs(routes: Record<string, Route> = {}) {
  const requests: MockRequest[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const entry: MockRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    requests.push(entry);
    const route = Object.entries(routes).find(([key]) => {
      const [method, pattern] = key.split(' ') as [string, string];
      return method === entry.method && new RegExp(`^${pattern}$`).test(entry.path);
    });
    const reply = route?.[1](entry) ?? { status: 404, body: { detail: 'not mocked' } };
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

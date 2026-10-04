// `pnpm spike`: the hour-1 spike page (spike/index.html) on http://localhost:8099, with a /token
// route that mints WebRTC tokens for the real agents. Needs ELEVENLABS_API_KEY and the agent ids.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { httpElevenLabsClient } from '../src/elevenlabs.js';

const ids: Record<string, string | undefined> = {
  interviewer: process.env.EL_INTERVIEWER_AGENT_ID,
  debrief: process.env.EL_DEBRIEF_AGENT_ID,
  tutor: process.env.EL_TUTOR_AGENT_ID,
};
const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
const el = httpElevenLabsClient({ apiKey, timeoutMs: 5000 });
const page = new URL('../spike/index.html', import.meta.url);
const port = Number(process.env.SPIKE_PORT ?? 8099);

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/token') {
      const agentId = ids[url.searchParams.get('agent') ?? ''];
      if (!agentId) throw new Error(`no agent id for ${url.searchParams.get('agent')}`);
      const { token } = await el.conversationToken(agentId);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(page));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err));
  }
}).listen(port, '127.0.0.1', () => console.log(`spike page on http://localhost:${port}`));

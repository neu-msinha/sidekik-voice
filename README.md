# sidekik-voice

The ElevenLabs layer for Sidekik (`hooks.sidekik.live`, port 8085). It keeps the Interviewer and Tutor agents as code, mints conversation tokens per phase for the gateway, persists transcripts, reconciles them with the post-call webhook, and pushes each published Work Map to the Tutor agent. Spec: `docs/DESIGN.md`.

## Run

```bash
pnpm install
cp .env.example .env     # fill in from the team vault
pnpm dev                 # needs Redis: docker compose -f ../sidekik-platform/dev/docker-compose.yml up -d
pnpm dev:mock            # no ElevenLabs, Supabase or teammates' services
pnpm typecheck && pnpm test
```

`GET /healthz` returns `{ok, version, deps}` (Redis, Supabase).

## Agents as code

`agents/` holds the ElevenLabs agents (DESIGN §3):

| Path | What |
|---|---|
| `agents/agents.json` | One entry per agent: config, prompt file, tools, and the env var holding its id |
| `agents/agent_configs/*.json` | The `PATCH /v1/convai/agents/{id}` body without prompt and tools (LLM, voice, ASR, turn, overrides, auth) |
| `agents/prompts/*.md` | System prompts, injected at push time; `{{expert_name}}` etc. are ElevenLabs dynamic variables |
| `agents/tools/*.json` | Client and webhook tools; `{{TOOLS_BASE_URL}}` and `{{SK_TOOL_SECRET}}` are filled in at push time |

There are three agents: **Sidekik Interviewer** (capture), **Sidekik Interviewer (debrief)** and **Sidekik Tutor**. ElevenLabs can't bind a prompt override to a WebRTC conversation token (overrides only come from the browser SDK), so the debrief prompt and its Normal turn eagerness live in an agent of their own; `/internal/token` picks it for `phase = debrief`.

```bash
pnpm agents:push --dry-run             # print the composed bodies (tool secret masked)
pnpm agents:push                       # create missing agents (prints their ids), PATCH the rest
pnpm agents:push --only tutor
pnpm agents:webhook https://hooks.sidekik.live   # workspace post-call webhook → EL_POST_CALL_WEBHOOK_ID, EL_WEBHOOK_SECRET
```

First setup: `pnpm agents:push` (creates the agents; put the printed ids in `.env` and Railway), `pnpm agents:webhook https://hooks.sidekik.live`, then `pnpm agents:push` again to attach the webhook. Pushing keeps the knowledge base the Work Map sync attached to the Tutor. Pick each agent's voice in the ElevenLabs dashboard; the configs don't pin a `voice_id`.

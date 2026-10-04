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

## Endpoints

| Route | Auth | What |
|---|---|---|
| `POST /internal/token` | `X-Internal-Token` | `{agent, phase, session_id, dynamic_variables, language}` → `{conversation_token, agent_id}`. A WebRTC token from `GET /v1/convai/conversation/token` for the phase's agent: the Tutor, the Interviewer's debrief agent for `phase = debrief`, otherwise the Interviewer. The page passes `dynamic_variables` (and any language override) to `startSession`; ElevenLabs can't bind them to the token. `502`/`504` when ElevenLabs fails or takes over 450 ms. |
| `POST /elevenlabs/post-call` | ElevenLabs signature | The post-call webhook (`hooks.sidekik.live`). Checks `elevenlabs-signature` (`t=…,v0=…`, HMAC-SHA256 over `{t}.{body}` with `EL_WEBHOOK_SECRET`, 30 minutes old at most); `401` otherwise. For `post_call_transcription` (other types answer `200 ignored`), the session comes from the `session_id` dynamic variable, and the turns are reconciled (below). |
| `GET /healthz` | none | `{ok, version, deps}` |

Bus:
- consumes `sk:transcript.turns` → `transcript_turns` (`source = "live"`);
- consumes `sk:workmap.published` → the Tutor agent's knowledge base and Procedures (below);
- publishes `sk:usage` (one record per conversation, from the post-call webhook).

### Work Map sync

On `sk:workmap.published`, voice loads `workmaps/org/{org}/{workmap_id}/v{n}/workmap.json` and `AGENT_RULES.md` from Storage (mapper writes them before it publishes), then:

1. creates the knowledge-base document `workmap-{id}-v{n}.md` from `AGENT_RULES.md` (or a rendering of `workmap.json` if that file is missing) and attaches it to the Tutor with RAG on, in place of the workflow's earlier versions, whose documents are deleted;
2. creates one free-form Procedure per step (decision, the expert's reason quoted, its guardrails, when to ask for a prediction) and one structured **Intervention** Procedure, deletes the earlier versions' Procedures, and publishes every Procedure left on the agent's branch;
3. records the ids in `agent_configs` (`procedure_ids`: `{step_id: id, "intervention": id}`).

Each version syncs once. The row is written as soon as the document exists, so a retried event reuses the document. If the Procedures fail, the tutor still has the KB document (the cut order allows that) and the failure is logged.

### Post-call reconciliation

1. Each transcript turn is placed on the session timeline: `t_ms` = conversation start (`metadata.start_time_unix_secs`) − session start + `time_in_call_secs`.
2. Turns inside an `off_record_spans` span (open spans included) are dropped.
3. The rest are redacted through gateway `POST /internal/redact` (webhook text arrives unredacted). If that fails, the turn is skipped, never stored unredacted, and the webhook answers `503` so a retry can finish it.
4. A turn with the same role, within ±1.5 s and at least 50% word overlap with a stored turn replaces that row's text and sets `source = "webhook"`, keeping its `turn_id` (evidence points at it). Otherwise it's inserted as `el:{conversation_id}:{n}`. Repeating the webhook is safe.
5. `sk:usage` gets one record per conversation (`usage-el-{conversation_id}`): `call_duration_secs` in minutes at $0.08 (`PRICE_TABLE.elevenlabs.agent`).

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

## Hour-1 spike

`pnpm spike` serves a test page on `http://localhost:8099` that talks to the real agents. The questions, protocol and results are in `NOTES.md`.

## Deploy

Railway service `voice` from this repo's `main`, built with the `Dockerfile` (`node:22-slim`; runs as `node`; `HEALTHCHECK` on `/healthz`). It listens on `::` and `PORT`. Public host: `hooks.sidekik.live` (Cloudflare, proxied) for the ElevenLabs post-call webhook. The gateway reaches `/internal/token` over the private network (`VOICE_URL=http://voice.railway.internal:8085`).

| Variable | Production value |
|---|---|
| `PORT` | `8085` |
| `REDIS_URL` | Railway Redis (shared) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | the team's Supabase project |
| `SK_INTERNAL_TOKEN` | shared variable |
| `SK_TOOL_SECRET` | shared with gateway and tutor (sent by the agents' webhook tools) |
| `LOG_LEVEL` | `info` |
| `ELEVENLABS_API_KEY` | ElevenLabs workspace key (Agents read/write, knowledge base, webhooks) |
| `EL_INTERVIEWER_AGENT_ID`, `EL_DEBRIEF_AGENT_ID`, `EL_TUTOR_AGENT_ID` | printed by `pnpm agents:push` |
| `EL_WEBHOOK_SECRET` | printed by `pnpm agents:webhook https://hooks.sidekik.live` |
| `GATEWAY_INTERNAL_URL` | `http://gateway.railway.internal:8080` |
| `NPM_GITHUB_TOKEN` (build only) | read-only token if sidekik-platform is private |

`EL_POST_CALL_WEBHOOK_ID` and `TOOLS_BASE_URL` are only read by `pnpm agents:push`, run from a laptop.

Order for a fresh environment:
1. Deploy voice.
2. `pnpm agents:push` and set the three agent ids.
3. `pnpm agents:webhook https://hooks.sidekik.live` and set `EL_WEBHOOK_SECRET`.
4. `pnpm agents:push` again with `EL_POST_CALL_WEBHOOK_ID` to attach the webhook.
5. Redeploy voice.

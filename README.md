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

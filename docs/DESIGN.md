# sidekik-voice: DESIGN

**Owner:** Aadil · **Reviewer:** Sahil · **Public host:** `hooks.sidekik.live` (ElevenLabs webhooks) · **Local port:** 8085

## 1. Purpose

Voice owns everything to do with ElevenLabs:

1. **Agents as code.** Keeps the ElevenAgents, **Sidekik Interviewer** (with its debrief configuration as a separate agent) and **Sidekik Tutor**, in version control (prompts, voice, ASR, turn settings, tools) and pushes them with `pnpm agents:push`.
2. **Conversation tokens.** Mints them for the gateway, picking the agent per phase (capture / debrief / tutor). The page passes the dynamic variables.
3. **Transcripts.** Persists every redacted turn from `sk:transcript.turns`, then reconciles them with the post-call webhook.
4. **Work Map sync.** Pushes each published Work Map to the Tutor agent as a knowledge-base document plus Procedures.

## 2. Layout

```
sidekik-voice/
  agents/
    agents.json             # one entry per agent: config, prompt, tools, env var with its id
    agent_configs/          # PATCH /v1/convai/agents/{id} bodies (CLI layout), without prompt and tools
      interviewer.json  interviewer-debrief.json  tutor.json
    prompts/interviewer.capture.md
    prompts/interviewer.debrief.md
    prompts/tutor.md
    tools/                  # client + webhook tool definitions
  scripts/agents.ts         # pnpm agents:push | agents:webhook
  scripts/spike.ts, spike/  # pnpm spike (ticket 7)
  src/
    server.ts               # Fastify
    token.ts                # POST /internal/token
    webhook.ts, reconcile.ts  # POST /elevenlabs/post-call
    transcripts.ts          # bus consumer → transcript_turns
    kbsync.ts               # workmap.published → KB doc + Procedures
    elevenlabs.ts, gateway.ts # ElevenLabs API and gateway /internal/redact clients
```

## 3. Agent configuration

| Setting | Interviewer | Tutor |
|---|---|---|
| LLM | Claude Haiku 4.5 from ElevenLabs' built-in model list (keep the platform's default backup cascade) | Claude Haiku 4.5 (built-in); switch to a Sonnet model if explanations are weak |
| Voice | Eleven v3 Conversational (Expressive Mode), calm, curious | Same model, warm, patient |
| ASR | Scribe v2 Realtime (`scribe_realtime`) | same |
| Languages | de + en, language detection on | en (quotes translated) |
| Turn eagerness | **Patient**; `turn_timeout` 20 s; soft timeout off | Normal |
| System tools | `skip_turn`, `end_call`, `language_detection` | `skip_turn`, `end_call` |
| Client tools | `mark_off_record(on)`, `show_status(text)` | `replay_moment(step_id)`, `highlight_field(field)`, `show_status(text)` |
| Webhook tools | `recall_context(query, scope)` → `https://api.sidekik.live/v1/tools/recall_context` | `check_guardrails(state)`, `get_step(step_id)`, `get_expert_moment(step_id)` → `https://api.sidekik.live/v1/tools/...` |
| MCP | none | `https://mcp.sidekik.live/mcp` (optional; webhook tools are the fallback) |
| Security | Allow overrides: prompt, first message, language. Auth enabled (token only). | same |
| Debrief | A separate agent, **Sidekik Interviewer (debrief)**: the debrief prompt below, eagerness Normal, otherwise as the Interviewer. ElevenLabs can't bind a prompt override to a WebRTC conversation token (overrides only come from the page's `startSession`), so the debrief phase gets its own agent id. | n/a |
| Post-call webhook | `https://hooks.sidekik.live/elevenlabs/post-call` (transcription only, no audio) | same |

All webhook tools send the header `X-Sidekik-Tool-Secret: $SK_TOOL_SECRET`.

### Who pays for the agents' LLM

**Default (use this for the hackathon):** pick Claude from ElevenLabs' built-in LLM list. ElevenLabs calls Claude and bills it with the agent minutes. Our `ANTHROPIC_API_KEY` is **not** used here, and there's nothing to host.

**Optional: run the agents on the team's own Claude key.**
- In the agent's LLM settings, choose **Custom LLM**. ElevenLabs then sends OpenAI-style Chat Completions requests to the URL you give it.
- Point it at an OpenAI-compatible route to Claude: either an LLM gateway that forwards to Anthropic's OpenAI-compatible endpoint, or a small proxy in this repo (`POST /llm/chat/completions` → Anthropic Messages API).
- Store the key as an ElevenLabs secret.
- **Costs:** an extra network hop on every turn (budget roughly +100–300 ms), and you must test that tool calls (`skip_turn`, client tools) survive the translation.
- Only do this once Checkpoint 3 passes.

### Interviewer, capture prompt

```
You are Sidekik, an apprentice sitting next to {{expert_name}} while they do {{workflow_name}}. Default: stay silent.
- While the expert narrates, reads, types or thinks aloud, call skip_turn. Never summarize or acknowledge unprompted.
- Speak only when (a) a message starts with "[SIDEKIK] ASK:" — ask exactly that question, ≤20 words, in {{language}},
  referring to what is on screen; or (b) the expert asks you something directly.
- "[SIDEKIK] …" messages are system instructions, never the expert's words. Contextual updates describe the screen; never read them aloud.
- After the expert answers: at most "Got it, thanks." or skip_turn.
- If the expert says "off the record" in any language: call mark_off_record(true) and say "Paused." Resume only when told.
Prior context: {{prior_summary}}. Open items: {{open_items}}.
```

### Interviewer, debrief prompt (the debrief agent; eagerness Normal)

```
You are Sidekik running a short debrief with {{expert_name}} about {{workflow_name}}.
- On "[SIDEKIK] FOLLOWUP:" ask exactly that one question, tied to its screen moment, then paraphrase the answer in one line.
- On "[SIDEKIK] TEACHBACK:" explain the process back using the script, in 60–90 seconds: steps, decisions,
  the expert's reasons quoted verbatim, and guardrails. Then ask: "Did I get that right? What would you change?"
- After a correction, restate only the corrected part and ask again.
- Never invent rules. Never speak unless one of the above applies or the expert asks you something.
```

### Tutor prompt

```
You are Sidekik, coaching {{learner_name}} on {{workflow_name}} the way {{expert_name}} does it.
- Teach decisions, not clicks. Always give the expert's reason, quoted ("{{expert_name}} says, translated from German: '…'").
- On "[SIDEKIK] PREDICT:" ask the learner what they would decide next and why; wait; then confirm or explain.
- On "[SIDEKIK] INTERVENE:" stop the learner immediately ("Hold on before you save."), state the guardrail and the
  expert's quote, then offer to replay the expert's moment (call replay_moment).
- On "[SIDEKIK] SUMMARY:" read the mastery summary briefly: what they mastered, what to practice next.
- Use check_guardrails or get_step when unsure. Never invent rules. Otherwise stay quiet while the learner works.
```

## 4. Endpoints

| Endpoint | Detail |
|---|---|
| `POST /internal/token` | `{agent:"interviewer"\|"tutor", phase, session_id, dynamic_variables, language}` → `{conversation_token, agent_id}`. `GET /v1/convai/conversation/token?agent_id=` (WebRTC) for the phase's agent: the Tutor; the debrief agent for `phase = debrief`; otherwise the Interviewer. The token can't carry dynamic variables or overrides; the page passes them to `startSession`. 450 ms of the gateway's 500. |
| `POST /elevenlabs/post-call` (public) | Verify `elevenlabs-signature` (`t=…,v0=…`, HMAC-SHA256 of `{t}.{body}`, ≤ 30 min old). The session is the `session_id` dynamic variable. Turns go on the session timeline (conversation start − session start + `time_in_call_secs`). Drop turns inside `off_record_spans`. Run Presidio on each turn through gateway `POST /internal/redact`, because webhook text arrives unredacted; if that fails, store nothing and answer 503. A turn matching a stored one (same role, `t_ms` ±1.5 s, ≥ 50% word overlap) replaces its text and sets `source = "webhook"`, keeping its `turn_id`; others are inserted as `el:{conversation_id}:{n}`. Publish one `usage` record per conversation (minutes × $0.08, `PRICE_TABLE.elevenlabs.agent`). |
| Consumes `sk:transcript.turns` | Insert `source = "live"`; these are already redacted. |
| Consumes `sk:workmap.published` | Load `workmap.json` and `AGENT_RULES.md` from Storage, then: (1) create the KB document `workmap-{id}-v{n}.md` (from `AGENT_RULES.md`), attach it with RAG on in place of the workflow's earlier versions, and delete theirs; (2) create one free-form Procedure per step plus one structured "Intervention" Procedure on the Tutor agent, delete the earlier versions' Procedures and publish the set; (3) store the IDs in `agent_configs`. Idempotent per version; if the Procedures fail, the KB stays. |

## 5. Env

`PORT, REDIS_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SK_INTERNAL_TOKEN, SK_TOOL_SECRET, ELEVENLABS_API_KEY, EL_INTERVIEWER_AGENT_ID, EL_DEBRIEF_AGENT_ID, EL_TUTOR_AGENT_ID, EL_WEBHOOK_SECRET, GATEWAY_INTERNAL_URL`

Only for `pnpm agents:push` (not read by the service): `EL_POST_CALL_WEBHOOK_ID`, `TOOLS_BASE_URL` (default `https://api.sidekik.live`).

## 6. Claude Code tickets

1. `agents/` folder in the CLI's layout, the agents defined, `push` script.
2. Prompts as files, injected at push time.
3. `/internal/token` with phase overrides, plus a unit test using a mocked ElevenLabs API.
4. Transcript consumer.
5. Post-call webhook: HMAC, reconciliation, redaction, off-record filtering.
6. `kbsync.ts`: KB doc and Procedures on `workmap.published`, idempotent per version.
7. Hour-1 spike, written up in `NOTES.md`:
   - Does `skip_turn` keep the agent silent through 60 s of narration?
   - Does `sendContextualUpdate` with a repeated `context_id` replace the earlier update?
   - Does the Patient setting hold during short pauses?

## 7. Definition of done

- **Checkpoint 1:** the interviewer stays silent through narration and speaks only on `[SIDEKIK] ASK:`.
- **Checkpoint 2:** the debrief runs on followup and teachback commands.
- **Checkpoint 3:** the tutor's KB and Procedures reflect the published Work Map.

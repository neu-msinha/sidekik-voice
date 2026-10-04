# Hour-1 spike (DESIGN §6 ticket 7)

The whole capture design rests on the Interviewer staying quiet while the expert works. This spike checks that against the pushed agents before anything else depends on it.

**Status: not run yet.** Running it needs `ELEVENLABS_API_KEY`, the pushed agents (`pnpm agents:push`) and a browser with a microphone. Fill in the results table below when it's done.

## How to run it

```bash
pnpm agents:push            # creates or updates the agents; put the printed ids in .env
pnpm spike                  # http://localhost:8099
```

The page starts a WebRTC session with a token from `GET /v1/convai/conversation/token`, passes the same dynamic variables the gateway does, and logs every status change, mode change (`speaking`/`listening`) and message with a timestamp. The "agent spoke" counter goes up each time the agent starts speaking.

## Questions and protocol

| # | Question | Protocol | Pass if |
|---|---|---|---|
| 1 | Does `skip_turn` keep the agent silent through 60 s of narration? | Interviewer. Start the 60 s timer and narrate continuously in German while "working": reading values aloud, half sentences, "und dann…". Repeat in English. | The agent speaks 0 times in both runs. |
| 2 | Does `sendContextualUpdate` with a repeated `context_id` replace the earlier update? | Send ctx #1, then ctx #2 (both `context_id: "screen"`). Then ask out loud: "What's the cost center on screen?" | The answer is 0400, not 4711, and the agent never reads either update aloud. Also check the conversation in the ElevenLabs dashboard: `contextual_update_info.is_superseded` should be true on #1. |
| 3 | Does Patient eagerness hold during short pauses? | Narrate with 2–5 s pauses mid-thought ("Die Rechnung geht auf … [3 s] … 0400"). | No agent turn starts during the pauses. |
| 4 | Does the agent speak on `[SIDEKIK] ASK:`? | Click **[SIDEKIK] ASK** while silent. | It asks exactly that question (≤ 20 words), then stays quiet after the answer ("Got it, thanks." at most). |
| 5 | Debrief and Tutor smoke test | Switch to the debrief agent and the Tutor; send nothing. | Neither speaks first (`first_message` is empty). |

## What we know from the SDK and docs (2026-10-04)

- `sendContextualUpdate(text, { contextId })` sends `{type: "contextual_update", text, context_id}`. ElevenLabs marks an earlier update with the same `context_id` as superseded (`ContextualUpdateInfo.is_superseded`). Whether a superseded update also leaves the LLM's context is what question 2 checks.
- `skip_turn` is a system tool: the agent stays silent until the user re-engages. It takes an optional `reason`.
- Prompt overrides can't be bound to a conversation token, only passed by the page's `startSession`. That's why the debrief prompt has its own agent (README, "Agents as code").
- The soft timeout isn't set in `agents/agent_configs/interviewer.json`. If the agent fills silences, check `turn.soft_timeout_config` in the dashboard and turn it off there, then mirror the setting into the config.

## Results

| # | Date | Result | Notes |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |

**If question 1 fails:** move the silence rule to the top of the prompt, try `turn_eagerness: "patient"` with a longer `turn_timeout`, then a stricter LLM (`claude-sonnet-*`), and record each attempt here. The fallback is to mute the agent's audio in the page between `[SIDEKIK] ASK:` messages, which needs a change in sidekik-web.

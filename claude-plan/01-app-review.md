# 01 — App review

## What the app is

A push-to-record interview copilot for Windows. During a live call, the user
presses **Record** while the other person speaks. The app:

1. captures system audio (WASAPI loopback via `getDisplayMedia`, not the mic),
2. streams it to Deepgram Nova-3 over a WebSocket so a live transcript renders
   while the other person is still talking,
3. on **Stop & Answer**, finalizes the transcript and streams a suggested
   answer from Claude Haiku 4.5 (default) or Groq `openai/gpt-oss-120b`,
4. shows the measured stop-to-first-word latency.

Secondary features: a typed **Ask** box (same pipeline, no audio),
**Regenerate** (re-asks the viewed question), a 6-entry in-memory **history**,
an **answer style** toggle (brief / balanced / detailed), a **global hotkey**,
and window **content protection** (hidden from screen shares).

## How it is built

| Area | Files | Notes |
|---|---|---|
| Window, hotkey, crash log | `src/main/main.ts` | Single-instance lock, sandboxed renderer, renderer crash recovery |
| IPC | `src/main/ipc.ts` | zod-validated handlers; `createStt` / `createLlm` factories read the store per request |
| Session state machine | `src/main/session.ts` | One active session; newer start/ask supersedes older; per-stage timeouts (5 s STT finalize, 10 s first token, 60 s total) |
| STT | `src/main/stt/deepgram.ts` | Native WebSocket; URL is a fixed constant (lines 19–22) |
| LLM | `src/main/llm/anthropic.ts`, `groq.ts`, `retry.ts`, `warm.ts` | One retry on pre-stream connection failure only; TLS pre-warm on record/stop |
| Prompt | `src/main/prompt.ts` | Pure. System prompt split into `cachedPrefix` + `styleSuffix` |
| Settings | `src/main/store.ts` | zod per-field fallback, atomic write, DPAPI-encrypted keys |
| Renderer | `src/renderer/app.ts`, `history.ts`, `ui-state.ts`, `format.ts`, `markdown.ts` | State: idle → starting → recording → finalizing → answering |
| Preload | `src/preload.ts` | Typed `contextBridge` API (`RendererApi` in `src/shared/types.ts`) |

### The request the model receives today

```
system[0]  cache_control: ephemeral
           ROLE_INSTRUCTIONS (interview-specific)
           --- THE USER'S RESUME ---        <resume>
           --- THE JOB THEY ARE INTERVIEWING FOR ---   <jd>
           "Ground every answer in the resume and target role above.
            Never invent experience the resume does not support."
system[1]  style instruction (brief | balanced | detailed)
messages   [ user: 'The other person on the call just said:\n"""\n<transcript>\n"""\n\nWhat should I say?' ]
```

Groq receives the same content with the two system blocks joined by `\n\n`
into one system message. Verbatim code is in
[appendix-current-code.md](appendix-current-code.md).

## Health

- **Tests:** 620/620 passing (vitest, 15 files, no Electron or network needed).
- **Typecheck:** clean on both main and renderer configs.
- **Correctness:** I read every file in `src/` except `renderer/markdown.ts`
  and `renderer/styles.css`, which do not affect this feature. I found no
  correctness bugs that need fixing before this work. Session races,
  timeouts, the retry policy and the cache split are all carefully handled
  and heavily tested.
- **Housekeeping:** about 2.2k lines of changes are uncommitted on `main`
  (19 modified, 9 untracked). They are green and should be committed first.

## Gaps that block tailoring

These are the reasons the owner cannot currently adapt the output to a
situation or a question.

| # | Gap | Where | Effect |
|---|---|---|---|
| G1 | The prompt only knows about job interviews | `prompt.ts:21-26` (role text), `:60-66` (section labels, grounding line) | A sales call, client meeting or 1:1 gets interview-flavored answers and "never invent experience the resume does not support" |
| G2 | One resume and one job description for everything | `store.ts:19-30`, `types.ts:13-26` | Each new company or call type means opening Settings and re-pasting. There's nothing to switch between |
| G3 | The only control is answer length, and "detailed" hard-codes STAR | `prompt.ts:30-41` | "Detailed" always says "what the situation was, what you did, what the result was", which is wrong for technical or sales questions |
| G4 | No memory between questions | `anthropic.ts:56` (`messages` holds only the current turn); `session.ts:25` (`generate(transcript, …)`) | Follow-ups ("what was the outcome?", "can you go deeper on that?") are answered with no knowledge of the previous exchange. The renderer holds 6 Q/A pairs (`app.ts:59`) but never sends them |
| G5 | No way to steer one answer | `ui-state.ts:22` (`askLocked` during starting/recording/finalizing) | While recording, the ask box is disabled, which is exactly when the user would want to type "use the Acme migration story" |
| G6 | Deepgram gets no vocabulary hints | `deepgram.ts:19-22` | Company names, product names and jargon get mistranscribed, and the answer is generated from that transcript |

## Smaller observations (not blocking, outside the core feature)

- Profile text is paste-only. There's no file import (`.txt`, `.md`, `.pdf`).
- History is in-memory, capped at 6, and lost on restart. There's no export.
- The model is fixed per provider (`MODEL` constants). There's no per-situation
  choice between speed and quality.
- The main view is already dense at the 380×520 minimum window size (status,
  record button, notice, meter, ask box, style row, two panels). Any new
  controls need to earn their space. See the risk in 04.

# Interview Practice Partner

A Windows practice assistant built with Electron and TypeScript. Record a
practice question or type one, then study the streamed answer and rehearse it
in your own words. Interview answers use your background and target role;
other saved scenarios support technical discussions, client calls, and meetings.

## Tailor answers

Open **Settings** to add your resume, job description, **Personal profile**, and
**System prompt customization**. Personal profile supplies facts about your
experience and goals. Custom instructions control tone, focus, structure, or
example language and can override the default interview coaching format.

Open **Context & Instructions** to create reusable interview, technical,
client, meeting, or custom profiles. Each profile has its own background,
instructions, resume/job-description inclusion settings, and independent length,
format, tone, and audience controls. Draft edits apply to the next request;
**Save profile** keeps them across restarts. A separate note applies to the next
question and clears only after a successful answer.

Record and Ask capture the current context. Later settings changes affect
future requests. Regenerate with the original context or deliberately use the
current controls. Shorter, More specific, Change tone, Go deeper, and Worked
example revise or expand the selected answer without rewriting saved defaults.
Edit question lets you correct a transcription before asking again.

**Follow up** explicitly continues the selected entry, including its existing
conversation branch. Context retains the original exchange and the five most
recent exchanges, with per-turn and total limits. New questions start fresh;
unrelated history is never silently included. Generated suggestions are marked
as unconfirmed, not treated as evidence of your experience. History and
snapshots stay in memory for the current run.

New installations default to brief answers. Existing saved length preferences
are preserved. Interview answers normally include **Key beats** for rehearsal;
custom instructions and explicit follow-ups can request a different format.
See [the context guide](docs/CONTEXT.md) for precedence, limits, and migration.

## Audio, models, and feedback

- **Microphone** is the default audio source. Choose **System audio** in Settings
  to practice against a video, call, or recorded question list.
- Choose **Anthropic** or **Groq** and a model in Settings. Provider and model are
  captured for each request, so switching them during recording does not change
  that recording's answer provider.
- The latency chip measures time to the first token received in the main
  process. It excludes IPC delivery and renderer painting. Hover for the STT
  finalization, first-token, and total breakdown.
- The cost chip shows an estimate where the repository has a pricing entry,
  otherwise token counts. Hover for model and cache usage. Estimates use the
  table in `src/main/llm/pricing.ts`; they are not billing records.
- The global shortcut defaults to `CommandOrControl+Shift+Space`. Change it or
  leave it empty to disable it. Settings reports registration failures.

## Setup

```sh
npm install
npm start
```

Open Settings and add the selected answer provider's API key to use typed
questions. Add a Deepgram key for recording. Windows may request microphone
permission. Blank key inputs leave saved keys unchanged; explicit clear
controls remove them. The renderer receives presence flags, never stored keys.

Keys use Electron safeStorage when encryption is available; the Settings
indicator reports the actual storage mode. Existing app data stays under the
unchanged **AI Call Assistant** product name. The practice window is visible
in screen captures, so you can record your rehearsal.

## Reliability and implementation

- Electron 43, strict TypeScript, Vite, and a sandboxed renderer.
- Deepgram streaming transcription, Anthropic SDK, and Groq-compatible SSE.
- One active session; session-tagged events, cancellation, bounded requests,
  early-event buffering, and stage timeouts prevent stale answers and hangs.
- Providers retry a connection failure once before output starts; HTTP errors,
  aborts, and failures after streamed output are not retried.
- Shared prompt composition separates references from instructions and places
  output preferences after the stable cache prefix. Actual cache use depends on
  provider/model requirements and prefix length; low latency is not guaranteed.
- Validated settings recover individual damaged fields and save atomically.
  Single-instance locking prevents competing settings writes; window geometry,
  crash logging, and renderer recovery help preserve usability.
- Streaming Markdown renders with text nodes instead of HTML injection. The
  interface includes focus management, keyboard controls, live announcements,
  visible errors, and reduced-motion support.

## Checks and packaging

| Command | What it does |
|---|---|
| `npm start` | Build and launch Electron |
| `npm test` | Offline unit and component tests |
| `npm run typecheck` | Strict main and renderer TypeScript checks |
| `npm run test:ui` | Built renderer/preload checks and layout screenshots with fake providers |
| `npm run test:smoke` | Electron, real IPC/store, and simulated Groq streaming without network or real keys |
| `npm run dist` | Build the Windows NSIS installer |

[Testing guide](docs/TESTING.md) documents automated coverage.
[Manual acceptance checklist](docs/FINAL_TEST.md) covers real audio and provider
behavior that offline checks cannot establish. Screenshots from the UI smoke
check are saved under `artifacts/ui-smoke/`.

## Source layout

| Path | Responsibility |
|---|---|
| `src/shared/types.ts` | IPC contracts, context, models, audio source, usage |
| `src/shared/context.ts` | Profile templates, snapshot resolution, limits |
| `src/main/context-schema.ts` | Context validation at the process boundary |
| `src/main/main.ts` | Window, loopback grant, shortcut, instance and crash handling |
| `src/main/ipc.ts`, `session.ts` | Validated commands and request lifecycle |
| `src/main/prompt.ts` | Grounded scenario and practice prompts |
| `src/main/stt/`, `llm/`, `sse.ts` | Provider streams, retries, usage and pricing |
| `src/main/store.ts`, `bounds.ts` | Settings, secrets and saved window geometry |
| `src/preload.ts` | Typed renderer bridge |
| `src/renderer/` | Context editor, recording, history, answers, Markdown and UI state |
| `test/`, `scripts/` | Offline tests and Electron smoke checks |

The audio worklet duplicates the small PCM helpers in `src/shared/pcm.ts`;
keep them in sync. `docs/spec/REBUILD_PROMPT.md` is a historical Tauri proposal;
the implemented app is Electron. Earlier roadmap and status documents record
prior milestones; this README and the context/testing guides describe the
combined implementation.

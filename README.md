# AI Call Assistant

**Context & Instructions:** tailor answers with saved interview, technical,
client, meeting, or custom profiles; background and custom instructions;
independent length, format, tone, and audience; and a note for the next question.
Regenerate with original or current context, refine an answer, or explicitly
follow up on the selected entry. See [the context guide](docs/CONTEXT.md) for
behavior, limits, migration, and validation.

Push-to-record call assistant for Windows. Captures system audio (the other
person's voice on a call), streams it to a live transcript **while they are
still speaking**, and starts streaming an AI-suggested answer within about a
second of pressing Stop under favorable provider and network conditions.

This is the v2 rewrite of `Desktop/aihelper`: same interaction model and
Windows loopback/screen-hide moat, new pipeline built for latency.

## How it gets fast

```
record pressed   session:start (Deepgram WS) and getDisplayMedia spin up in
                 PARALLEL; audio frames captured before the session resolves are
                 held in the renderer (cap ~15 s) and flushed the moment it does
while recording  AudioWorklet → 16 kHz Int16 → ~128 ms frames → Deepgram;
                 partial transcript renders live, is_final marks committed text
stop pressed     the latency clock starts here. CloseStream flushes the tail
                 (5 s cap) → LLM request fires immediately, cached prefix intact
answer           first token streams into the panel; when it completes, the
                 measured stop-to-first-word lands in the panel header
```

On top of that, the main process **pre-warms the LLM connection**
(`llm/warm.ts`): a throttled, fire-and-forget request opens a pooled TCP+TLS
connection to the active provider's origin when recording starts and again the
instant Stop is pressed — so the TLS handshake runs concurrently with the STT
finalize instead of inside the stop-to-first-word window. Node's fetch (undici)
pools per origin, and both the Anthropic SDK and the Groq fetch draw from that
pool.

The pre-open buffering that makes this work lives in the **renderer**
(`app.ts` holds frames until `session:start` resolves, then replays them).
`DeepgramStream` also has an internal pre-open buffer, but in practice it never
fills: the session only sends audio after `connect()` resolves, and `connect()`
resolves on socket open. Treat that one as defence, not as the mechanism.

Don't take the latency on faith — the UI reports the real number
(`AnswerMetrics`, measured in main from the moment Stop is pressed).

## Stack

- **Electron 43 + strict TypeScript + Vite** (renderer) / tsc (main, preload)
- **STT**: Deepgram Nova-3 streaming (WebSocket, linear16 @ 16 kHz)
- **LLM**: Claude Haiku 4.5 (`claude-haiku-4-5`, official SDK, prompt caching on
  the resume+JD block) — or a Groq `openai/gpt-oss-120b` "fastest" preset, with
  `reasoning_effort: 'low'` + `include_reasoning: false` so a reasoning model
  doesn't spend your first-token budget thinking
- **Reliability**: one active session at a time; session IDs tag every event;
  re-recording aborts the in-flight session; per-stage timeouts (5 s STT
  finalize, 10 s LLM first token, 60 s total); structured `{code, message}`
  errors; mid-stream STT failures surface as `stt_error` instead of silently
  truncating the transcript; both providers retry a pre-stream connection
  failure exactly once (never after a delta reached the panel, never on an
  HTTP error status)
- **Secrets**: API keys encrypted with Electron `safeStorage` (DPAPI); the
  renderer only ever sees `hasKey` flags. `settings.json` is zod-validated on
  read (per-field fallback, so one bad value can't cost you your resume) and
  written atomically via write-then-rename
- **Production hardening**: single-instance lock (a second launch focuses the
  running window instead of fighting it for the hotkey and settings file); the
  renderer runs with the full Chromium **sandbox** enabled; uncaught
  main-process errors are appended to `%APPDATA%/AI Call Assistant/crash.log`
  instead of killing the app mid-interview; a crashed renderer is reloaded
  (once per 10 s) rather than left as a frozen window; window size/position
  persist across launches, with off-screen positions recovered when a monitor
  disappears
- Window is `setContentProtection(true)` — invisible to screen shares.

### In the window

- **Global hotkey** toggles record/stop from any app. Default
  `CommandOrControl+Shift+Space`, editable in Settings, empty to disable. If
  another app already owns the accelerator, registration fails and the UI says
  so rather than leaving you pressing a dead key. Ignored while Settings is open.
- **Ask box** — type a question and get a streamed answer without recording:
  the fallback when call audio isn't available, and the way to ask your own
  follow-ups. Runs through the same session pipeline (same events, same
  timeouts, same metrics with the STT stage at 0 ms).
- **Regenerate and refine** — re-ask the viewed question with its original
  context snapshot or the current controls. Shorter, More specific, Change tone,
  and Edit question create a new history entry. Follow-up context is explicit
  and bounded; prior AI suggestions are never treated as confirmed user speech.
- **Answer length** — brief / balanced / detailed, independently combined with
  format, tone, and audience. Presentation changes preserve the stable cached
  prefix; they are not a guarantee of identical latency.
- **Latency readout** — time to first token received by the main process, with
  STT finalize / first token / total breakdown. It excludes IPC and UI painting.
- **History** — last 6 Q/A pairs, arrow-key-free prev/next in the panel header,
  plus a clear button (enabled while idle).
- **Markdown answers** — dependency-free streaming renderer. Every string
  reaches the DOM via `createTextNode`/`textContent`, never `innerHTML`; links
  are deliberately not parsed, so there's no href to sanitize. Diffs at block
  level, so completed paragraphs keep their nodes (no flicker, no lost
  selection) — and re-parses only past the last proven-safe block boundary, so
  a streaming frame costs O(tail), not O(document) (~5× faster streaming a long
  answer; an unchanged frame is a single string compare). A large invariant
  suite pins incremental rendering byte-identical to a batch render at every
  cut point. Page CSP is `default-src 'self'; style-src 'self'`.
- **Accessibility** — `aria-live` on the answer panel (announced on completion,
  not per token), `role="alert"` errors, focus moved into and back out of
  Settings, Escape to close, visible focus rings, `prefers-reduced-motion`.
  Palette is picked for AA contrast on the dark theme — there's a dedicated
  `--accent-bright` token because the base accent only hit ~3:1 on dark fills.

### Cost

The LLM side is pennies. Haiku 4.5 is $1/$5 per MTok, and an answer is roughly
1–2K tokens of profile in plus a few hundred out — call it **~$0.002–0.003 per
answer**, so ~20 answers is around **$0.05**. Approximate: it scales with how
long your resume and JD are.

The bill is dominated by Deepgram's per-minute streaming rate for however long
you hold the record button. That rate isn't pinned here — check their current
pricing. Groq's pricing for `openai/gpt-oss-120b` isn't pinned here either.

## Setup

```sh
npm install
npm start        # build + launch
```

First run: open Settings (gear icon) and add

1. a **Deepgram** API key (console.deepgram.com — free credit tier),
2. an **Anthropic** API key (platform.claude.com) — or a Groq key if you pick
   the Groq preset,
3. your resume and the job description (plain text).

Keys are stored encrypted per-machine and can be replaced but never read back.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Build everything and launch Electron |
| `npm test` | Offline Vitest unit and component suite |
| `npm run test:ui` | Build and exercise the actual Electron renderer with isolated fake providers; save layout screenshots |
| `npm run typecheck` | Strict TS across main + renderer |
| `npm run dist` | Windows NSIS installer via electron-builder |

Tests cover prompt building, SSE parsing, PCM helpers, Deepgram frame parsing +
stream lifecycle, the session manager (recorded and typed questions, plus
supersession/timeout stress), the IPC layer (validation, Result envelopes,
event forwarding, the audio fast path), the settings store, the LLM providers
and their shared retry policy, the connection pre-warm, window-bounds
sanitization, the renderer's display formatters, the history/state modules, the
markdown parser + streaming DOM view (including streaming-vs-batch invariants),
and the full renderer glue driven against the real markup under happy-dom. No
Electron and no network needed. **Every test is documented in
[docs/TESTING.md](docs/TESTING.md)** — what it verifies and why it exists.

## Layout

```
src/
  shared/
    types.ts      IPC contract, error codes, AnswerMetrics, DEFAULT_HOTKEY
    pcm.ts        pure PCM helpers (shared by tests and both processes)
  main/
    main.ts       window, loopback grant, content protection, global shortcut,
                  single-instance lock, crash log, renderer crash recovery
    bounds.ts     pure window-geometry sanitization for restoring saved bounds
    ipc.ts        zod-validated handlers; events tagged { sessionId }; pre-warm calls
    session.ts    one active session; new session aborts old; timeouts; metrics;
                  ask() for typed/re-asked questions (no STT stage); the shared
                  guard/stream pipeline both paths run through
    sse.ts        OpenAI-style SSE chunk/tail parser (used by Groq)
    stt/deepgram.ts   WS client: keepalive, finalize, mid-stream error reporting,
                      O(1) committed-transcript accumulation
    llm/anthropic.ts  Haiku 4.5, two-block system prompt, one connection retry
    llm/groq.ts       OpenAI-compatible SSE streaming, reasoning suppressed,
                      one connection retry, 1024-token completion cap
    llm/retry.ts  the one-retry-on-connection-failure policy both providers share
    llm/warm.ts   throttled fire-and-forget TLS pre-warm of the provider origin
    prompt.ts     system prompt split at the cache breakpoint (pure, tested)
    store.ts      zod-validated settings + safeStorage-encrypted keys; atomic
                  write; window-bounds persistence
  preload.ts      typed contextBridge with unsubscribe functions
  renderer/
    app.ts        glue: idle → starting → recording → finalizing → answering,
                  wired over the pure history/ui-state modules
    history.ts    pure Q/A history: live-entry lifecycle, trim, view cursor
    ui-state.ts   pure per-state UI descriptor (labels, dot, status, ask lock)
    format.ts     pure display helpers: accelerator labels, timer, latency strings
    markdown.ts   markdown subset: pure parser + streaming DOM view (XSS-safe,
                  committed-prefix incremental — O(tail) per streamed frame)
    index.html    main + settings views, ask box, style chips
    styles.css    dark theme, AA-contrast palette, focus rings
    public/pcm-worklet.js  capture → downsample → Int16 frames + level meter
test/             Vitest tests, no Electron or network needed
scripts/ui-smoke.cjs  isolated Electron renderer/preload smoke checks, no live APIs
docs/TESTING.md   every test documented: what it verifies and why it exists
```

## Notes

- **Prompt caching, honestly.** The system prompt is two blocks with the cache
  breakpoint after resume+JD; the answer-style policy sits *after* it. Caching is
  a prefix match, so that split is what lets you toggle brief/balanced/detailed
  without throwing away the cached resume and paying a full uncached prefill on
  the next answer.

  It only pays once the profile is big enough. Haiku 4.5's minimum cacheable
  prefix is **4096 tokens**, and a typical 1–2K-token resume+JD never reaches it
  — the marker is a silent no-op: no error, nothing cached, full price. Past
  roughly 16K characters of profile it engages, and then writes cost 1.25x and
  reads 0.1x, so it breaks even on the **second question** and every question
  after that is cheaper *and* faster to first token. Cache entries have a
  5-minute TTL, so a long gap between questions pays a fresh write. Read
  `usage.cache_read_input_tokens` to check whether it's actually engaging.
- The Groq model is pinned in `src/main/llm/groq.ts`. It was
  `llama-3.3-70b-versatile`, which Groq announced as deprecated on 2026-06-17
  with a hard shutdown on 2026-08-16; `openai/gpt-oss-120b` is Groq's own
  recommended replacement. A 404 from Groq surfaces as "update MODEL in
  llm/groq.ts", because that's the likely cause.
- The audio worklet duplicates the small downsample/int16 helpers from
  `src/shared/pcm.ts` (worklets can't import bundled code). Keep them in sync.

# AI Call Assistant v2

Push-to-record interview copilot for Windows. Captures system audio (the other
person's voice on a call), streams it to a live transcript **while they are
still speaking**, and starts streaming an AI-suggested answer within about a
second of pressing Stop.

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
  truncating the transcript
- **Secrets**: API keys encrypted with Electron `safeStorage` (DPAPI); the
  renderer only ever sees `hasKey` flags. `settings.json` is zod-validated on
  read (per-field fallback, so one bad value can't cost you your resume) and
  written atomically via write-then-rename
- Window is `setContentProtection(true)` — invisible to screen shares.

### In the window

- **Global hotkey** toggles record/stop from any app. Default
  `CommandOrControl+Shift+Space`, editable in Settings, empty to disable. If
  another app already owns the accelerator, registration fails and the UI says
  so rather than leaving you pressing a dead key. Ignored while Settings is open.
- **Answer style** — brief / balanced / detailed. `balanced` is v1's wording
  verbatim, so the default behaviour is unchanged.
- **Latency readout** — "X.Xs to first word" per answer; hover for the STT
  finalize / first token / total breakdown.
- **History** — last 6 Q/A pairs, arrow-key-free prev/next in the panel header.
- **Markdown answers** — dependency-free streaming renderer. Every string
  reaches the DOM via `createTextNode`/`textContent`, never `innerHTML`; links
  are deliberately not parsed, so there's no href to sanitize. Diffs at block
  level, so completed paragraphs keep their nodes (no flicker, no lost
  selection). Page CSP is `default-src 'self'; style-src 'self'`.
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
| `npm test` | Vitest suite (199 tests across 8 files) |
| `npm run typecheck` | Strict TS across main + renderer |
| `npm run dist` | Windows NSIS installer via electron-builder |

Tests cover prompt building, SSE parsing, PCM helpers, Deepgram frame parsing +
stream lifecycle, the session manager, the settings store, the LLM providers,
and the markdown parser. No Electron and no network needed.

## Layout

```
src/
  shared/
    types.ts      IPC contract, error codes, AnswerMetrics, DEFAULT_HOTKEY
    pcm.ts        pure PCM helpers (shared by tests and both processes)
  main/
    main.ts       window, loopback grant, content protection, global shortcut
    ipc.ts        zod-validated handlers; events tagged { sessionId }
    session.ts    one active session; new session aborts old; timeouts; metrics
    sse.ts        OpenAI-style SSE chunk/tail parser (used by Groq)
    stt/deepgram.ts   WS client: keepalive, finalize, mid-stream error reporting
    llm/anthropic.ts  Haiku 4.5, two-block system prompt, one connection retry
    llm/groq.ts       OpenAI-compatible SSE streaming, reasoning suppressed
    prompt.ts     system prompt split at the cache breakpoint (pure, tested)
    store.ts      zod-validated settings + safeStorage-encrypted keys; atomic write
  preload.ts      typed contextBridge with unsubscribe functions
  renderer/
    app.ts        state machine: idle → starting → recording → finalizing → answering
    markdown.ts   markdown subset: pure parser + streaming DOM view (XSS-safe)
    index.html    main + settings views
    styles.css    dark theme, AA-contrast palette, focus rings
    public/pcm-worklet.js  capture → downsample → Int16 frames + level meter
test/             199 vitest tests, no Electron or network needed
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

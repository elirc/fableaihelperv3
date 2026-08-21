# Interview Practice Partner

Mock-interview practice tool for Windows. A practice partner (a friend, your
spouse, a recorded question list) asks you an interview question out loud; the
app transcribes it **while they are still speaking** and, about a second after
you press Stop, streams the **model answer** — the answer a strong, well-prepared
candidate would give, grounded in your resume and target job description. You
study it, learn the key beats, and practise saying it in your own words.

This is the practice-mode rework of the v2 low-latency pipeline: same
sub-second engineering, pointed at rehearsal. Each answer ends with a
**Key beats** section — the two to four points worth memorising — because the
prose is what good sounds like, and the beats are what you actually keep.

## How a practice round works

```
partner asks     press Record; the question transcribes live while they speak
                 (default source: microphone; switchable to system audio to
                 practise against a video call or a played question list)
stop pressed     the latency clock starts. STT finalizes (5 s cap) → the LLM
                 request fires immediately, cached prefix intact
model answer     streams into the panel; the header shows the measured
                 stop-to-first-word latency AND the estimated cost of the answer
you practise     read it, close it, answer the same question out loud yourself;
                 press Regenerate to see a fresh take, or ask a follow-up in
                 the Ask box
```

## Comparing models (latency + cost)

Settings offers a curated model picker per provider, and every answer carries
two chips:

- **latency** — "X.Xs to first word", measured in the main process from the
  moment Stop is pressed; hover for the STT-finalize / first-token / total
  breakdown.
- **cost** — an estimated dollar figure for Anthropic models (pricing pinned in
  `src/main/llm/pricing.ts`, verified 2026-08-20), or a raw `in→out tok` count
  for Groq, whose pricing is deliberately not pinned here. Hover for the model
  name and full token accounting, including prompt-cache reads/writes.

| Provider | Models | Notes |
|---|---|---|
| Anthropic | Haiku 4.5 ($1/$5 per MTok, default) · Sonnet 5 ($3/$15) · Opus 5 ($5/$25) | Sonnet/Opus think by default; the app disables thinking for them so the first token isn't spent reasoning |
| Groq | GPT-OSS 120B (default) · GPT-OSS 20B · Llama 3.1 8B Instant | Reasoning suppressed on the gpt-oss family; cost chip shows tokens only |

Ask the same question across a few models and the chips give you the real
latency/cost/quality trade — measured, not guessed.

## Stack

- **Electron 43 + strict TypeScript + Vite** (renderer) / tsc (main, preload)
- **STT**: Deepgram Nova-3 streaming (WebSocket, linear16 @ 16 kHz)
- **LLM**: Anthropic (official SDK, prompt caching on the resume+JD block) or
  Groq (OpenAI-compatible SSE); model picked in Settings
- **Latency**: pre-warmed TLS connections to the provider origin
  (`llm/warm.ts`), renderer-side frame buffering while the STT session opens,
  prompt-cache breakpoint placed so style flips never invalidate the cached
  resume+JD
- **Reliability**: one active session at a time; session IDs tag every event;
  re-recording aborts the in-flight session; per-stage timeouts (5 s STT
  finalize, 10 s LLM first token, 60 s total); structured `{code, message}`
  errors; both providers retry a pre-stream connection failure exactly once
  (never after a delta reached the panel, never on an HTTP error status)
- **Secrets**: API keys encrypted with Electron `safeStorage` (DPAPI); the
  renderer only ever sees `hasKey` flags. `settings.json` is zod-validated on
  read (per-field fallback, so one bad value can't cost you your resume) and
  written atomically via write-then-rename

### In the window

- **Audio source** — microphone (default: a partner asking questions in the
  room) or system audio (practise against a call, a video, or a recorded
  question list). Echo cancellation stays on for the mic path so the app's own
  playback doesn't leak into the question.
- **Global hotkey** toggles record/stop from any app. Default
  `CommandOrControl+Shift+Space`, editable in Settings, empty to disable.
- **Ask box** — type a question and get a streamed model answer without
  recording: same pipeline, same metrics, STT stage at 0 ms.
- **Regenerate** — re-asks the viewed question as a fresh answer (new history
  entry), so comparing two models on the same question costs two clicks:
  switch model in Settings, press Regenerate.
- **Answer style** — brief / balanced / detailed, switchable from the main view
  via chips. A style flip is latency-free by design: the cached prompt prefix
  is split before the style suffix.
- **History** — last 6 Q/A pairs with prev/next and a clear button, so a
  cross-model comparison stays on screen.
- **Markdown answers** — dependency-free streaming renderer; every string
  reaches the DOM via `createTextNode`/`textContent`, never `innerHTML`. Page
  CSP is `default-src 'self'; style-src 'self'`.
- **Accessibility** — `aria-live` answer panel, `role="alert"` errors, focus
  management in Settings, visible focus rings, `prefers-reduced-motion`,
  AA-contrast palette.

### Cost

The LLM side is pennies on Haiku (~$0.002–0.003 per answer; the cost chip shows
the real number), more on Sonnet/Opus — that's the point of the picker. The
bill is otherwise dominated by Deepgram's per-minute streaming rate for however
long you hold Record. That rate isn't pinned here — check their pricing.

## Setup

```sh
npm install
npm start        # build + launch
```

First run: open Settings (gear icon) and add

1. a **Deepgram** API key (console.deepgram.com — free credit tier),
2. an **Anthropic** API key (platform.claude.com) — or a Groq key if you pick
   the Groq provider,
3. your resume and the job description (plain text).

Keys are stored encrypted per-machine and can be replaced but never read back.
Windows will ask for microphone permission on the first recording.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Build everything and launch Electron |
| `npm test` | Vitest suite (see `docs/TESTING.md`) |
| `npm run typecheck` | Strict TS across main + renderer |
| `npm run dist` | Windows NSIS installer via electron-builder |

## Layout

```
src/
  shared/
    types.ts      IPC contract, error codes, AnswerMetrics/AnswerUsage,
                  curated model lists, audio source type
    pcm.ts        pure PCM helpers (shared by tests and both processes)
  main/
    main.ts       window, loopback grant (system-audio source), global shortcut
    ipc.ts        zod-validated handlers; events tagged { sessionId }; pre-warm calls
    session.ts    one active session; timeouts; metrics incl. usage;
                  ask() for typed/re-asked questions (no STT stage)
    sse.ts        OpenAI-style SSE chunk/tail parser + usage extraction (Groq)
    stt/deepgram.ts   WS client: keepalive, finalize, mid-stream error reporting
    llm/anthropic.ts  model from Settings, two-block cached system prompt,
                      usage + cost reporting, thinking disabled on Sonnet/Opus
    llm/groq.ts       OpenAI-compatible SSE streaming, usage accounting,
                      reasoning suppressed on gpt-oss, 1024-token cap
    llm/pricing.ts    pinned Anthropic pricing + cost estimator (never guesses)
    llm/warm.ts   throttled fire-and-forget TLS pre-warm of the provider origin
    prompt.ts     mock-interview coach prompt, split at the cache breakpoint
    store.ts      zod-validated settings + safeStorage-encrypted keys; atomic write
  preload.ts      typed contextBridge with unsubscribe functions
  renderer/
    app.ts        state machine: idle → starting → recording → finalizing → answering;
                  mic/system capture switch
    format.ts     pure display helpers: latency, cost/token chips, timer
    markdown.ts   markdown subset: pure parser + streaming DOM view (XSS-safe)
    index.html    main + settings views, ask box, style chips, model pickers
    styles.css    dark theme, AA-contrast palette, focus rings
    public/pcm-worklet.js  capture → downsample → Int16 frames + level meter
test/             vitest suite, no Electron or network needed
docs/TESTING.md   test documentation
```

## Notes

- **Prompt caching, honestly.** The system prompt is two blocks with the cache
  breakpoint after resume+JD; the answer-style policy sits *after* it. Caching
  is a prefix match, so that split lets you toggle brief/balanced/detailed
  without invalidating the cached resume+JD. The minimum cacheable prefix is
  **per model**: 4096 tokens on Haiku 4.5, 1024 on Sonnet 5, 512 on Opus 5. A
  typical 1–2K-token profile therefore silently doesn't cache on the Haiku
  default (it starts engaging around 16K+ characters of profile) but **does
  cache on Sonnet 5 and Opus 5** — expect their chips to show `cached read`
  tokens from the second question onward. Cache entries have a 5-minute TTL; a
  long gap between questions pays a fresh write.
- **Model pricing** is pinned in `src/main/llm/pricing.ts` with a
  verified-on date. When prices change, update that file — the UI shows
  whatever it computes, and a stale table means stale chips. Groq deliberately
  has no entry: tokens are shown instead of a guessed dollar figure.
- **Practice-tool posture.** v1 hid the window from screen capture
  (`setContentProtection`) for covert use on live calls. That's gone: this is
  a rehearsal tool, and being capturable means you can record your practice
  sessions. The `productName` (and therefore the settings directory) is
  unchanged so existing keys and profiles survive the upgrade.
- The audio worklet duplicates the small downsample/int16 helpers from
  `src/shared/pcm.ts` (worklets can't import bundled code). Keep them in sync.

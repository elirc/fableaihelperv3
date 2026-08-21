# Interview Practice Partner — Implementation Plan

**Date:** 2026-08-20
**Status:** practice-mode conversion and model-comparison harness delivered and verified; three reviews complete; next phases awaiting approval.
**Short version:** `docs/STATUS.md`.

The practice-mode conversion and the model-comparison harness are done and
verified. Three reviewers (Fable orchestrating, two latency specialists) went
over the work; this document folds their findings into one sequence to
approve, trim, or reorder.

| | |
|---|---|
| Tests | **416 / 416** passing (was 379), 11 files |
| Functional bugs found in review | **0** |
| Independent reviews | **3** |
| Typecheck · vite build | **clean** |

---

## 1. What shipped this session

Everything below is in the working tree, **uncommitted**, so it can be diffed
before it lands.

### Practice-mode conversion

- **System prompt** (`src/main/prompt.ts`) is now a mock-interview coach. Answers
  are shaped by question type — behavioural ("tell me about a time…"),
  technical ("what are React hooks?"), motivation ("why this role?") — and
  grounded in the resume + JD with a rule against inventing experience. Every
  answer ends with a **Key beats** section: the 2–4 points worth memorising.
  A generic "no internal or system XML tags" guard line is included (see
  Findings).
- **Audio source**: microphone is the default (`getUserMedia` with echo
  cancellation, noise suppression, AGC) for a partner asking in the room;
  system-audio loopback is retained as a Settings option for practising
  against a call, video, or recorded question list. Mic failures give specific
  messages for permission-denied vs no-device.
- **Window**: `setContentProtection(true)` removed — nothing to hide, and being
  capturable lets you record practice sessions. Title is "Interview Practice
  Partner". `productName` is deliberately unchanged so the Electron userData
  folder (and your encrypted keys and profile) stays where it is.
- **Wording**: all UI, status text, placeholders, error messages, README and
  test docs moved to the practice framing.

### Model comparison harness

- **Curated pickers in Settings** (`shared/types.ts`):
  Anthropic — `claude-haiku-4-5` (default), `claude-sonnet-5`, `claude-opus-5`;
  Groq — `openai/gpt-oss-120b` (default), `openai/gpt-oss-20b`,
  `llama-3.1-8b-instant`. The inactive provider's picker is greyed out.
- **Request shaping per model**: Sonnet 5 / Opus 5 run adaptive thinking by
  default, which would spend the first-token budget reasoning, so they get
  `thinking: {type: 'disabled'}` (valid: the app never sets effort above the
  default `high`). Haiku gets no thinking param. Groq sends
  `reasoning_effort: 'low'` + `include_reasoning: false` only for the gpt-oss
  family (llama rejects them) and `stream_options: {include_usage: true}`.
- **Latency + cost chips on every answer**: "X.Xs to first word" (hover for
  STT-finalize / first-token / total) and a cost chip — dollars for Anthropic
  models from pinned pricing in `src/main/llm/pricing.ts` (Haiku $1/$5,
  Sonnet 5 $3/$15, Opus 5 $5/$25 per MTok; cache write 1.25×, read 0.1×;
  verified 2026-08-20), or `in→out tok` for Groq, whose pricing is deliberately
  not pinned. Hover shows model, in/out tokens, and cache reads/writes.
- **Plumbing**: `LlmProvider.generate` gained an optional `onUsage` callback
  (existing 3-arg callers and test doubles unchanged); session threads usage
  into `AnswerMetrics.usage` (key absent when a provider reports nothing);
  `sse.ts` extracts `usage` / `x_groq.usage`; store and IPC validate the new
  settings with per-field fallbacks so a v2.0 `settings.json` loads clean.

### Docs and tests

- README rewritten for the practice framing and the comparison workflow.
- `docs/TESTING.md` updated: counts table, stale entries fixed, and a dated
  addendum documenting all 37 new tests (incl. new `test/pricing.test.ts`).
- Cache-minimum claims corrected per model: Haiku 4.5 = 4096 tokens,
  Sonnet 5 = 1024, Opus 5 = 512 — a typical 1–2K-token profile caches on the
  paid tiers but not on Haiku.

---

## 2. Review verdicts

### Fable — full review + plan critique
*25 tool calls, verified against the diff.*
No functional bugs. The old code's load-bearing invariants — retry only before
the first delta, byte-stable cached prefix, session staleness, key-absence
metric semantics — all survived and are pinned by the new tests; cost
accounting is bucket-correct (Anthropic's `input_tokens` excludes cache
tokens, so summing all four buckets is right). Verdict: **ready for the first
real-API session**, with the smoke test as the remaining gate. Its pre-smoke
fixes are applied: anti-tag guard line, cache-minimum docs, picker gating,
specific mic errors, stale test docs, `DEFAULT_*_MODEL` constants in the
renderer fallbacks, "preset" → "provider".

### Latency review — pipeline internals
*Ranked, each with how to measure it using existing `AnswerMetrics`.*
Confirmed the pre-warm genuinely covers both providers' connection pool (SDK
0.111 resolves `globalThis.fetch`; Groq uses raw fetch; same undici dispatcher,
same origin and ALPN), and that Deepgram's `CloseStream` flush, the IPC audio
path, and the rAF render batching are already right. Found two real wins
(idle-timeout, speculative start) and one accuracy bug (last ≤128 ms of speech
dropped at Stop).

### Latency review — provider / API level
*Headers curl'd live; Deepgram / Groq / Anthropic docs checked.*
No request parameter sent is wrong for any listed model. Verified live that
neither `api.anthropic.com` nor `api.groq.com` sends a `Keep-Alive` timeout
hint, so undici drops the warmed connection after its 4 s default idle.
Proposed a `max_tokens: 0` cache pre-warm. Flagged that Groq's
`include_reasoning: false` hides reasoning but does not skip it. Pricing table
and cache multipliers confirmed against current rates.

---

## 3. The plan

Ordered by value for one person practising with a partner.
Effort: **S** under an hour or two · **M** an evening or two · **gated** only
after measurement says it's needed.

### Phase 1 — First real session

**1. Run the smoke-test checklist** (S)
See §5. Ordered so the one real wire-level unknown (Groq's acceptance of
`stream_options.include_usage`) is hit early and cheaply, and so you leave
with chips recorded for ~3 questions × 4 models — the numbers every later
decision depends on.

### Phase 2 — Low-risk wins (do regardless of the numbers)

**2. Keep the warmed connection alive until Stop** (S)
Both latency reviewers ranked this first. Undici drops an idle pooled
connection after 4 s and neither provider sends a keep-alive hint, so the
connection warmed at Record is gone before Stop on any question longer than
four seconds. Only the Stop-press warm helps today, and it merely races the
transcript finalize. Fix: raise the global dispatcher's `keepAliveTimeout` to
~60 s at main startup, or re-warm every 3 s while recording (no new deps).
The existing single immediate retry on connection errors already absorbs the
rare stale-socket case. Expected ~100–250 ms off the right tail, made
deterministic.
*Files:* `src/main/main.ts`, `src/main/llm/warm.ts`, `src/main/ipc.ts`

**3. Stop dropping the last syllable** (S)
Accuracy bug: `endCapture()` closes the audio context with up to 128 ms still
unfilled in the worklet buffer; that tail never reaches Deepgram. Flush the
partial buffer on Stop and/or shrink the frame to ~32 ms. Costs ≤20 ms of
finalize.
*Files:* `src/renderer/public/pcm-worklet.js`, `src/renderer/app.ts`,
`src/shared/pcm.ts` (keep in sync)

**4. Paint the first token synchronously** (S)
The first delta waits for the next animation frame (~8 ms; hundreds of ms if
the window is unfocused and throttled). Render the empty→non-empty
transition immediately; keep frame batching afterwards.
*Files:* `src/renderer/app.ts`

**5. Model quick-switch chips in the main view** (S)
Like the style chips: switch model + Regenerate becomes one gesture, and the
active model shows next to the answer. The 80% of a side-by-side view at 20%
of the cost; the 6-entry history already holds the comparison. No
main-process changes.
*Files:* `src/renderer/index.html`, `app.ts`, `styles.css`

**6. Pre-write the prompt cache at Record** (S)
Replace the unauthenticated Anthropic warm with a `max_tokens: 0` messages
request carrying the same system blocks: warms the same TLS connection *and*
writes/refreshes the prompt cache, so the first question of a session (and any
after a 5-minute gap) rides a 0.1× cached prefix. ~$0.002 per warm when the
cache can't engage. Pays off mainly on Sonnet 5 / Opus 5 or a large profile —
decide after the smoke test shows which model you use.
*Files:* `src/main/llm/warm.ts`, `src/main/llm/anthropic.ts`

**7. Running session cost in the header** (S)
Renderer-only accumulator: "session · $0.041 · 12 answers".
*Files:* `src/renderer/app.ts`, `format.ts`, `index.html`, `test/format.test.ts`

### Phase 3 — The big latency lever

**8. Speculative LLM start during transcript finalize** (M, gated)
Today first-word latency ≈ finalize (150–500 ms) **plus** model TTFT, in
series. When the partner has finished asking, Deepgram has already promoted
the whole question to final text before Stop. Fire the LLM on that snapshot
concurrently with finalize; if the finalized transcript matches, keep the
already-streaming answer; if not, abort and re-ask. Expected ~150–450 ms on a
hit, zero on a miss; risk medium-high (double token spend on mismatch,
session state-machine care — an STT error mid-finalize must not kill a
speculative answer that will be confirmed). Hold deltas until the transcript
is confirmed so the panel never shows a mixed answer. **Build only if the
smoke test shows Haiku above ~1.5 s to first word.**
*Files:* `src/main/session.ts`, `src/main/stt/deepgram.ts` (snapshot accessor;
optional `endpointing=300`)

### Phase 4 — Practice features (the ones that use your partner)

**9. Practice scoring mode** (M)
After reading the model answer, you answer out loud; the app transcribes
*your* answer and streams a critique against the question, resume, and JD:
what landed, which key beats were missed, one thing to fix. Reuses the whole
pipeline with a second prompt builder (its own cache prefix) and a mode flag.
*Files:* `src/main/prompt.ts`, `src/shared/types.ts`, `src/main/ipc.ts`,
`session.ts`, `src/renderer/app.ts`, `index.html`, tests

**10. Question bank from the JD** (M)
Generate 15–20 likely questions grouped behavioural / technical / motivation
for your partner to ask. Right now she has to invent them — the real
bottleneck of the loop. One-shot generation, copyable list.
*Files:* `src/main/prompt.ts`, `src/main/ipc.ts`, `src/renderer`

### Cut, with reasons

- **Full side-by-side comparison view** — large effort for one evening of
  novelty; item 5 + history covers it.
- **Deepgram `Finalize`-message flush instead of `CloseStream`** — 0–50 ms at
  best, needs a fallback timer because the response isn't guaranteed.
- **Persistent Deepgram socket across recordings** — the connect already
  overlaps mic spin-up and isn't on the stop-to-first-word path.
- **Padding the profile to hit Haiku's 4096-token cache minimum** — costs more
  than it saves.

---

## 4. Latency findings, ranked

Where the milliseconds go after Stop today: transcript finalize (150–500 ms)
→ TLS handshake if the pool is cold (100–250 ms) → model first token (Haiku
~300–700 ms, Groq gpt-oss ~150–400 ms) → one frame to paint.

| # | Change | Expected saving | Risk | How to verify |
|---|---|---|---|---|
| 1 | Speculative LLM start during finalize (item 8) | 150–450 ms on hit | Medium-high | `firstTokenMs − sttFinalizeMs` collapses toward zero on hits |
| 2 | Keep the warmed connection alive (item 2) | 100–250 ms, tail | Low | Compare first-word on >10 s vs <3 s recordings; tail tightens |
| 3 | `max_tokens: 0` cache pre-warm (item 6) | 50–150 ms when cache engages | Low | Cost hover shows cached-read tokens on question 1 |
| 4 | Choose a Groq model without a reasoning phase | 100–300 ms | None (a pick) | Llama 3.1 8B vs GPT-OSS 120B on the same question |
| 5 | First-delta synchronous paint (item 4) | ~8 ms; 100+ ms unfocused | Very low | Perceived only |
| — | Worklet tail flush (item 3) | −(≤20 ms) | Low | Accuracy win; transcript completeness on clipped endings |

**Already optimal (don't re-litigate):** `CloseStream` as the flush mechanism;
per-recording Deepgram connect (off the critical path, covered by renderer
frame buffering); warm origin/ALPN coverage; warm placement before
`await sessions.stop`; per-frame IPC cost; steady-state render batching;
`maxRetries: 0` + scoped connection retry; `max_tokens` 1024 (tail/cost, not
TTFT); prompt split at the cache breakpoint; Deepgram `nova-3` linear16 16 kHz
with no endpointing tuning.

> **Pricing note:** Sonnet 5 is on intro pricing ($2/$10 per MTok) through
> 2026-08-31; the chip pins the standard $3/$15, so Sonnet reads ~50% high until
> then. Deliberate — estimates shouldn't silently drop next month.

---

## 5. Smoke-test checklist

Needs real Deepgram + Anthropic keys (and a Groq key for the Groq rows).

- [ ] **Haiku default, microphone, partner asking from a realistic distance.** Transcript accuracy, live partials appear, first-word chip lands. Record the chip.
- [ ] **Press Stop with nobody speaking.** Expect the `no_speech` error pointing at the audio-source setting, not a hallucinated answer.
- [ ] **Toggle Windows microphone privacy off once, press Record.** Expect the specific "Microphone access is blocked… Privacy & security > Microphone" message.
- [ ] **Groq GPT-OSS 120B, same question via Regenerate.** The one wire-level unknown: if the request 400s, delete the `stream_options` line in `groq.ts`; the `x_groq.usage` fallback keeps the token chip alive.
- [ ] **Groq Llama 3.1 8B Instant.** Confirms reasoning params are omitted; shows the fastest possible first word.
- [ ] **Sonnet 5, then Opus 5, two questions each.** Watch for leaked `<thinking>` tags; confirm cached-read tokens appear in the cost hover from the second question.
- [ ] **Switch audio source to System, play a recorded question, Record.** Loopback path still works.
- [ ] **Write down first-word latency and cost for ~3 questions × 4 models.** These numbers decide items 6 and 8.

---

## 6. Decisions

1. **Approve Phase 2 as a batch?** Seven small items, all low risk, roughly an
   afternoon. *Recommended: yes, in the order shown,* holding item 6 until you
   know which model you'll use.
2. **Speculative start (item 8): build it if the numbers say so?** The only
   change that takes a real chunk out of first-word latency, and the only one
   that can double-spend tokens or show a wrong answer if done carelessly.
   *Recommended: gate on Haiku > ~1.5 s to first word.*
3. **Phase 4 order: scoring mode or question bank first?** *Recommended:
   question bank first* — smaller, and it improves every session after it;
   then scoring.
4. **Pin Groq pricing, or keep tokens only?** Tokens-only is honest but makes
   the comparison lopsided. If you want dollars for Groq, supply their current
   per-model rates and they'll be pinned with a verified-on date.
5. **Commit now?** *Recommended: one commit for the conversion + harness,* then
   Phase 2 as its own commit.

---

## Appendix — Running things on this machine

Node is installed via winget but not on PATH:
`%LOCALAPPDATA%\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.19.0-win-x64\`.
Either add it to PATH or invoke `node.exe` by full path. With it on PATH:
`npm test`, `npm run typecheck`, `npm run build`, `npm start`.

Sources: Fable review (verified against the working-tree diff), two latency
reviews (pipeline internals; provider/API with live header checks), this
session's test run (416 passing, 11 files). Pricing verified 2026-08-20.

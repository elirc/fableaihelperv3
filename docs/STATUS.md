# Status — 2026-08-20

> Historical practice-mode milestone. For the combined context-profile implementation
> and current checks, see [README](../README.md), [Context](CONTEXT.md), and [Testing](TESTING.md).

Snapshot of what changed in the practice-mode rework and where the app stands.
The full plan with review findings is in the published roadmap; this is the
short version.

## What the app is now

A mock-interview practice partner. Someone asks you a question out loud, the
app transcribes it live (Deepgram), and on Stop streams the **model answer** a
strong candidate would give, grounded in your resume + job description, ending
with a **Key beats** section to memorise. No covert-call features remain.

## What changed this session

| Area | Change |
|---|---|
| Prompt | `src/main/prompt.ts` rewritten as an interview coach: answers shaped by question type (behavioural / technical / motivation), mandatory Key beats, anti-XML-tag guard |
| Audio | Microphone is the default source (`getUserMedia`); system-audio loopback kept as a Settings option. Specific errors for mic-denied vs no-mic |
| Window | `setContentProtection` removed; title is "Interview Practice Partner". `productName` kept so the settings folder (and your saved keys) don't move |
| Models | Settings pickers: Claude Haiku 4.5 (default) / Sonnet 5 / Opus 5; Groq GPT-OSS 120B / 20B / Llama 3.1 8B. Sonnet/Opus get `thinking: disabled`; Groq drops reasoning params for non-gpt-oss models. Inactive provider's picker is greyed out |
| Cost + latency | Every answer shows a latency chip and a cost chip. Providers report usage via `onUsage`; `src/main/llm/pricing.ts` pins Anthropic rates (verified 2026-08-20); Groq shows tokens only |
| Plumbing | `AnswerUsage` on `AnswerMetrics`; `sse.ts` extracts usage; store/ipc validate `audioSource`, `anthropicModel`, `groqModel` with safe fallbacks for old settings files |
| Docs/tests | README rewritten; `docs/TESTING.md` updated; +37 tests (incl. new `test/pricing.test.ts`) |

## Verification

- `npm run typecheck` — clean (main + renderer)
- `npm run build` — clean
- `npm test` — **416 / 416** passing, 11 files
- Reviewed by three agents (Fable + two latency reviewers): **no functional bugs**; all pre-smoke fixes applied
- All changes are **uncommitted** in the working tree

## Known caveats

- Groq's `stream_options.include_usage` is unverified against the real API. If it 400s, delete that line in `src/main/llm/groq.ts`; the `x_groq.usage` fallback keeps the token chip working.
- Sonnet 5 chip pins standard $3/$15 while intro pricing ($2/$10) runs through 2026-08-31 — reads ~50% high until then.
- Prompt cache engages on Sonnet 5 / Opus 5 with a typical profile, but not on Haiku 4.5 (4096-token minimum).
- Node isn't on PATH on this machine; it lives under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_*`.

## Next steps (short form)

1. Smoke test with real keys — Haiku mic, no-speech, mic-denied, Groq 120B (the `include_usage` check), Llama 8B, Sonnet + Opus, system audio; record chips for ~3 questions × 4 models.
2. Low-risk wins: keep the pre-warmed TLS connection alive past undici's 4 s idle timeout (top latency finding), flush the worklet tail on Stop (last ≤128 ms of speech is dropped), paint the first token synchronously, model quick-switch chips, `max_tokens: 0` cache pre-warm, session cost total.
3. Gated on measurement: speculative LLM start during transcript finalize (~150–450 ms) only if Haiku is > ~1.5 s to first word.
4. Practice features: question bank from the JD, then scoring mode (critique of your spoken answer).

## Open decisions

Approve step 2 as a batch · build step 3 or not · question bank vs scoring first · pin Groq pricing (needs rates from you) · commit now.

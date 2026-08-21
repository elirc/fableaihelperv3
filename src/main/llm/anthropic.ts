import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_ANTHROPIC_MODEL, type AnswerStyle, type AppError } from '../../shared/types';
import type { LlmProvider } from '../session';
import { buildSystemPromptBlocks, buildUserMessage } from '../prompt';
import { estimateCostUsd } from './pricing';

// The model is now a Settings pick from ANTHROPIC_MODELS (shared/types.ts) so
// the user can compare latency/cost/quality across tiers on the same question.
// Haiku 4.5 stays the default: this app is judged on stop-to-first-word, and
// Haiku wins that. Sonnet 5 and Opus 5 are better writers at 3x/5x the price
// and a slower first token — the per-answer cost chip and the latency chip
// exist precisely so that trade is measured instead of guessed.
const MAX_TOKENS = 1024; // spoken-answer length; interview answers are short

// Sonnet 5 / Opus 5 run *adaptive thinking by default* (Haiku 4.5 has no such
// default). Left alone, the model may think before the first visible token —
// which is exactly the budget this app protects — so thinking is explicitly
// disabled for those models. Two footnotes, verified against the current API:
//   * `{type: 'disabled'}` is accepted on Opus 5 only at effort `high` or
//     below; the default effort is `high`, and we never set xhigh/max here.
//   * Haiku 4.5 never thinks unless explicitly asked to (the older
//     enabled+budget_tokens config), so it needs — and gets — no parameter.
const THINKING_DISABLED_MODELS = new Set(['claude-sonnet-5', 'claude-opus-5']);

// Prompt caching, honestly:
//
// The minimum cacheable prefix is PER MODEL: Haiku 4.5 = 4096 tokens,
// Sonnet 5 = 1024, Opus 5 = 512. A typical resume+JD lands around 1-2K
// tokens, so on the Haiku default the marker below is a *silent no-op* — no
// error, nothing cached, full price — until the profile reaches roughly 16K+
// characters. On Sonnet 5 and Opus 5 the same profile DOES cache, so those
// models get 0.1x cached-prefix reads from the second question onward.
//
// The marker stays on every model because when it engages it is free money:
// cache writes cost 1.25x and reads 0.1x, so it breaks even on the second
// question and every question after that is both cheaper and faster to first
// token. The breakpoint sits at the end of the resume+JD block, so the
// volatile answer-style instruction (which follows it) can change without
// throwing the cache away. The cost chip's hover shows `cached read` tokens
// when it is actually engaging (fed from `usage.cache_read_input_tokens`).
export function createAnthropicProvider(
  apiKey: string,
  resume: string,
  jd: string,
  answerStyle: AnswerStyle,
  model: string = DEFAULT_ANTHROPIC_MODEL,
): LlmProvider {
  // maxRetries: 0 — the SDK's default retry policy backs off for seconds, which
  // is forever mid-practice. We do our own single, immediate, tightly-scoped
  // retry below instead.
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  const { cachedPrefix, styleSuffix } = buildSystemPromptBlocks(resume, jd, answerStyle);

  return {
    async generate(transcript, onDelta, signal, onUsage) {
      // Built once so a retry re-sends byte-identical bytes and can still hit
      // the cache the first attempt may have written.
      const params: Anthropic.MessageStreamParams = {
        model,
        max_tokens: MAX_TOKENS,
        ...(THINKING_DISABLED_MODELS.has(model) ? { thinking: { type: 'disabled' as const } } : {}),
        system: [
          { type: 'text', text: cachedPrefix, cache_control: { type: 'ephemeral' } },
          // After the breakpoint: changing answerStyle costs nothing.
          { type: 'text', text: styleSuffix },
        ],
        messages: [{ role: 'user', content: buildUserMessage(transcript) }],
      };

      // Tracks whether anything has already been painted into the answer panel.
      // A retry is only safe while this is false — the renderer appends deltas,
      // so retrying after a partial answer would concatenate two answers.
      let streamedAny = false;
      const emit = (delta: string): void => {
        streamedAny = true;
        onDelta(delta);
      };

      const runOnce = async (): Promise<string> => {
        const stream = client.messages.stream(params, { signal });
        // Wrapped rather than passed directly: the SDK emits ('text', delta,
        // snapshot) and we must never let the running snapshot through as a delta.
        stream.on('text', (delta) => emit(delta));
        const final = await stream.finalMessage();
        // Usage is on the final message; report it (with the cost estimate)
        // before returning so the session can attach it to the metrics. The
        // cache_* fields are how you check whether prompt caching is actually
        // engaging (see the caching note above): read tokens at 0.1x mean it
        // is; everything landing in input_tokens means the prefix is under the
        // model's minimum cacheable size.
        const u = final.usage;
        const counts = {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        };
        const estCostUsd = estimateCostUsd(model, counts);
        onUsage?.({ model, ...counts, ...(estCostUsd !== undefined ? { estCostUsd } : {}) });
        // Concatenation of the text blocks == concatenation of the text deltas
        // that produced them, so the returned answer cannot diverge from what
        // was streamed. Do NOT "simplify" this to stream.finalText(): that
        // helper joins blocks with a SPACE, which would silently diverge from
        // the panel whenever the model emits more than one text block.
        return final.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
      };

      try {
        return await runOnce();
      } catch (err) {
        // A connection-level failure means the request never landed. Nothing is
        // on screen (streamedAny === false), the answer is not duplicated, and
        // the happy path pays nothing for this — so one immediate retry is
        // strictly better than showing the user an error mid-interview. It is
        // deliberately NOT extended to 429/5xx: those mean the server heard us
        // and said no, and an instant retry just burns the first-token budget.
        if (err instanceof Anthropic.APIConnectionError && !streamedAny && !signal.aborted) {
          try {
            return await runOnce();
          } catch (retryErr) {
            throw toLlmError(retryErr, signal, model);
          }
        }
        throw toLlmError(err, signal, model);
      }
    },
  };
}

function toLlmError(err: unknown, signal: AbortSignal, model: string): AppError {
  // MUST come first. The SDK reports a caller abort as APIUserAbortError, which
  // extends APIError with status === undefined — so the generic APIError branch
  // below would otherwise turn a user pressing record again into the scary
  // "Answer generation failed (HTTP undefined)". The session manager treats
  // 'aborted' specially and shows nothing, which is the whole point.
  if (signal.aborted || err instanceof Anthropic.APIUserAbortError) {
    return { code: 'aborted', message: 'Answer cancelled.' };
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return { code: 'llm_auth', message: 'Anthropic rejected the API key (401). Check it in Settings.' };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return {
      code: 'llm_auth',
      message: 'This Anthropic API key is not allowed to use ' + model + ' (403). Check the key in Settings.',
    };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return {
      code: 'llm_rate_limit',
      message: 'Anthropic rate limit reached (429). Wait a few seconds and ask again, or check your credit balance.',
    };
  }
  // Also covers APIConnectionTimeoutError. status is undefined on these, so they
  // must not fall through to the HTTP-status branch.
  if (err instanceof Anthropic.APIConnectionError) {
    return { code: 'llm_http', message: 'Could not reach Anthropic. Check your internet connection.' };
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 529) {
      return { code: 'llm_http', message: 'Anthropic is overloaded (529). Try again in a moment.' };
    }
    return { code: 'llm_http', message: `Answer generation failed (HTTP ${err.status}): ${err.message}` };
  }
  return { code: 'internal', message: err instanceof Error ? err.message : String(err) };
}

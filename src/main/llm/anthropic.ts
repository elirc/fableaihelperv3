import Anthropic from '@anthropic-ai/sdk';
import type { AnswerStyle, AppError } from '../../shared/types';
import type { LlmProvider } from '../session';
import { buildSystemPromptBlocks, buildUserMessage } from '../prompt';

// Claude Haiku 4.5 — verified current (200K context, $1/$5 per MTok). It is the
// fastest/cheapest tier Anthropic ships, which is the whole reason it is here:
// this app is judged on stop-to-first-word, and Haiku wins that. The bigger
// models are better writers but not better *here* — the answer is short, the
// grounding is spoon-fed in the system prompt, and every extra 100 ms of TTFT
// is worse than a slightly nicer sentence. (Opus fast mode is the only faster-
// than-standard option and it is Opus-tier priced and still not Haiku-fast.)
const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 1024; // spoken-answer length; interview answers are short

// Prompt caching, honestly:
//
// Haiku 4.5's minimum cacheable prefix really is 4096 tokens (Opus 4.x and
// Haiku 4.5 are the 4096 tier; Sonnet 4.5 and older are 1024). So the marker
// below is a *silent no-op* for a typical resume+JD, which lands around
// 1-2K tokens — no error, nothing cached, full price. It only starts paying at
// roughly 16K+ characters of profile.
//
// It stays because when it does engage it is free money: cache writes cost
// 1.25x and reads 0.1x, so it breaks even on the second question of an
// interview and every question after that is both cheaper and faster to first
// token. The breakpoint sits at the end of the resume+JD block, so the
// volatile answer-style instruction (which follows it) can change without
// throwing the cache away. Read `usage.cache_read_input_tokens` if you ever
// want to check whether it is actually engaging.
export function createAnthropicProvider(
  apiKey: string,
  resume: string,
  jd: string,
  answerStyle: AnswerStyle,
): LlmProvider {
  // maxRetries: 0 — the SDK's default retry policy backs off for seconds, which
  // is forever in an interview. We do our own single, immediate, tightly-scoped
  // retry below instead.
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  const { cachedPrefix, styleSuffix } = buildSystemPromptBlocks(resume, jd, answerStyle);

  return {
    async generate(transcript, onDelta, signal) {
      // Built once so a retry re-sends byte-identical bytes and can still hit
      // the cache the first attempt may have written.
      const params: Anthropic.MessageStreamParams = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
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
            throw toLlmError(retryErr, signal);
          }
        }
        throw toLlmError(err, signal);
      }
    },
  };
}

function toLlmError(err: unknown, signal: AbortSignal): AppError {
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
      message: 'This Anthropic API key is not allowed to use ' + MODEL + ' (403). Check the key in Settings.',
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

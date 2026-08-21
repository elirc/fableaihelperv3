import { DEFAULT_GROQ_MODEL, type AnswerStyle, type AppError } from '../../shared/types';
import type { LlmProvider } from '../session';
import { buildSystemPrompt, buildUserMessage } from '../prompt';
import { parseSSEChunk, parseSSETail, type SseUsage } from '../sse';

// Groq — the user-selectable "fastest" preset. OpenAI-compatible SSE
// streaming, parsed with the same battle-tested chunk parser v1 used for
// DeepSeek. The model is a Settings pick from GROQ_MODELS (shared/types.ts);
// `openai/gpt-oss-120b` stays the default (Groq's recommended replacement for
// the retired llama-3.3-70b-versatile, ~500 tok/s).
const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// gpt-oss is a reasoning model, and reasoning is the enemy of time-to-first-word:
// left alone it thinks before it answers, and the user stares at an empty panel.
// `reasoning_effort: 'low'` keeps that to a minimum, and `include_reasoning:
// false` keeps the reasoning out of the response entirely. Note gpt-oss does NOT
// accept `reasoning_format` (that is the Qwen-family knob) — these two are the
// supported controls for this model family. Non-reasoning models (the llama
// entry) reject these params, so they are sent only to the gpt-oss family.
const REASONING_EFFORT = 'low';

// Parity with anthropic.ts's MAX_TOKENS. Spoken answers are short; an uncapped
// runaway completion is pure tail latency (the panel keeps filling long after
// the user has the answer they need) and burns tokens for nothing. Groq's
// OpenAI-compatible API takes the newer `max_completion_tokens` name.
const MAX_COMPLETION_TOKENS = 1024;

export function createGroqProvider(
  apiKey: string,
  resume: string,
  jd: string,
  answerStyle: AnswerStyle,
  model: string = DEFAULT_GROQ_MODEL,
): LlmProvider {
  const system = buildSystemPrompt(resume, jd, answerStyle);
  const isReasoningModel = model.startsWith('openai/gpt-oss');

  return {
    async generate(transcript, onDelta, signal, onUsage) {
      // Serialized once so a retry re-sends byte-identical bytes (and does not
      // pay JSON.stringify twice) — same shape as the Anthropic provider.
      const body = JSON.stringify({
        model,
        stream: true,
        temperature: 0.7,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        ...(isReasoningModel ? { reasoning_effort: REASONING_EFFORT, include_reasoning: false } : {}),
        // Ask for token accounting on the final chunk so the answer can carry
        // a tokens chip. No cost estimate for Groq — pricing is not pinned
        // here (see llm/pricing.ts), and a wrong number is worse than none.
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: buildUserMessage(transcript) },
        ],
      });
      const attempt = (): Promise<Response> =>
        fetch(API_URL, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body,
        });

      let res: Response;
      try {
        res = await attempt();
      } catch {
        // fetch rejects with an AbortError when the session cancels us. That is
        // not a failure the user should ever see.
        if (signal.aborted) throw abortedError();
        // Retry parity with the Anthropic provider: a rejected fetch means the
        // request never landed — no HTTP status, no bytes on screen — so one
        // immediate retry is strictly better than an error mid-interview.
        // This is deliberately scoped to the *initial* fetch: HTTP error
        // statuses (401/429/5xx) resolve rather than reject and are never
        // retried (the server heard us and said no — an instant retry just
        // burns the first-token budget), and a mid-stream drop is handled
        // below without a retry (the renderer appends deltas, so a second
        // attempt would concatenate two answers).
        try {
          res = await attempt();
        } catch {
          if (signal.aborted) throw abortedError();
          throw {
            code: 'llm_http',
            message: 'Could not reach Groq. Check your internet connection.',
          } satisfies AppError;
        }
      }

      if (!res.ok) {
        // Reading the body can itself fail on a dropped connection; an error
        // about the error is not worth crashing over.
        const body = (await res.text().catch(() => '')).slice(0, 300);
        throw httpError(res.status, body, model);
      }

      // 200 with no body: `res.body!.getReader()` used to throw a raw
      // "Cannot read properties of null" TypeError here, which surfaced to the
      // user as an `internal` error with a JavaScript message in it.
      if (!res.body) {
        throw { code: 'llm_http', message: 'Groq returned an empty response body.' } satisfies AppError;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let full = '';
      let sseUsage: SseUsage | undefined;
      const emit = (delta: string): void => {
        full += delta;
        onDelta(delta);
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const { deltas, rest, usage } = parseSSEChunk(buf);
          buf = rest;
          if (usage) sseUsage = usage;
          for (const delta of deltas) emit(delta);
        }
      } catch (err) {
        if (signal.aborted) throw abortedError();
        throw {
          code: 'llm_http',
          message: 'The connection to Groq dropped while the answer was streaming.',
        } satisfies AppError;
      }

      // Flush, in two steps, both of which drop characters if skipped:
      //   decoder.decode()  — emits any multi-byte UTF-8 sequence left half-decoded
      //                       by the final chunk (stream: true holds those back).
      //   parseSSETail(buf) — emits a final `data:` line that arrived without its
      //                       trailing newline, which parseSSEChunk cannot flush.
      buf += decoder.decode();
      const tail = parseSSETail(buf);
      if (tail.usage) sseUsage = tail.usage;
      for (const delta of tail.deltas) emit(delta);

      if (sseUsage && typeof sseUsage.prompt_tokens === 'number' && typeof sseUsage.completion_tokens === 'number') {
        onUsage?.({
          model,
          inputTokens: sseUsage.prompt_tokens,
          outputTokens: sseUsage.completion_tokens,
          cacheReadTokens: 0, // no prompt caching on this path
          cacheWriteTokens: 0,
          // estCostUsd deliberately absent: Groq pricing is not pinned here.
        });
      }

      return full;
    },
  };
}

function abortedError(): AppError {
  return { code: 'aborted', message: 'Answer cancelled.' };
}

function httpError(status: number, body: string, model: string): AppError {
  if (status === 401 || status === 403) {
    // Both are key problems, but report the status we actually got — a 403
    // labelled "(401)" sends the user debugging the wrong thing.
    return { code: 'llm_auth', message: `Groq rejected the API key (HTTP ${status}). Check it in Settings.` };
  }
  if (status === 429) {
    return {
      code: 'llm_rate_limit',
      message: 'Groq rate limit reached (429). Wait a few seconds and ask again, or check your plan limits.',
    };
  }
  if (status === 404) {
    // Most likely cause here is Groq retiring the pinned model out from under us.
    return {
      code: 'llm_http',
      message: `Groq does not recognise the model "${model}" (404). It may have been retired — pick a different Groq model in Settings.`,
    };
  }
  if (status >= 500) {
    return { code: 'llm_http', message: `Groq is unavailable (HTTP ${status}). Try again in a moment.` };
  }
  return { code: 'llm_http', message: `Answer generation failed (HTTP ${status}): ${body}` };
}

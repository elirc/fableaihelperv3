import { DEFAULT_GROQ_MODEL, type AnswerStyle, type AppError, type ContextSnapshot } from '../../shared/types';
import type { LlmProvider } from '../session';
import { retryOnceIf } from './retry';
import { buildSystemPrompt, buildConversationMessages, contextForOptions, legacyContext, type PromptPersonalization } from '../prompt';
import { parseSSEChunk, parseSSETail, type SseError, type SseUsage } from '../sse';

// Groq — the user-selectable "fastest" preset. OpenAI-compatible SSE
// streaming, parsed with the same battle-tested chunk parser v1 used for
// DeepSeek. The model is a Settings pick from GROQ_MODELS (shared/types.ts);
// `openai/gpt-oss-120b` is the default public production model.
const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// gpt-oss is a reasoning model, and reasoning is the enemy of time-to-first-word:
// left alone it thinks before it answers, and the user stares at an empty panel.
// `reasoning_effort: 'low'` keeps that to a minimum, and `include_reasoning:
// false` keeps the reasoning out of the response entirely. Note gpt-oss does NOT
// accept `reasoning_format` (that is the Qwen-family knob) — these two are the
// supported controls for this model family. Non-reasoning models (the llama
// entry) reject these params, so they are sent only to the gpt-oss family.
const REASONING_EFFORT = 'low';

// The cap includes reasoning tokens. Leave room for hidden reasoning as well
// as the visible answer; the prompt controls the initial answer's concision.
const MAX_COMPLETION_TOKENS = 2048;
const DETAILED_COMPLETION_TOKENS = 4096;

export function createGroqProvider(
  apiKey: string,
  contextOrResume: ContextSnapshot | string,
  jdOrModel = '',
  answerStyle: AnswerStyle = 'brief',
  legacyModel: string = DEFAULT_GROQ_MODEL,
  personalization: PromptPersonalization = {},
): LlmProvider {
  const model = typeof contextOrResume === 'string' ? legacyModel : jdOrModel || DEFAULT_GROQ_MODEL;
  const savedContext = typeof contextOrResume === 'string' ? legacyContext(contextOrResume, jdOrModel, answerStyle, personalization) : contextOrResume;
  const isReasoningModel = model.startsWith('openai/gpt-oss');

  return {
    async generate(transcript, onDelta, signal, onUsage, options) {
      const context = contextForOptions(savedContext, options);
      const style = context.output.answerStyle;
      const system = buildSystemPrompt(context);
      // Serialized once so a retry re-sends byte-identical bytes (and does not
      // pay JSON.stringify twice) — same shape as the Anthropic provider.
      const body = JSON.stringify({
        model,
        stream: true,
        temperature: 0.7,
        max_completion_tokens: style === 'detailed' || (context.conversation?.length || context.relatedAnswer || context.refinement)
          ? DETAILED_COMPLETION_TOKENS : MAX_COMPLETION_TOKENS,
        ...(isReasoningModel ? { reasoning_effort: REASONING_EFFORT, include_reasoning: false } : {}),
        // Ask for token accounting on the final chunk so the answer can carry
        // a tokens chip. No cost estimate for Groq — pricing is not pinned
        // here (see llm/pricing.ts), and a wrong number is worse than none.
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: system },
          ...buildConversationMessages(transcript, context.conversation, context),
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
        res = await retryOnceIf(attempt, () => !signal.aborted);
      } catch {
        if (signal.aborted) throw abortedError();
        throw { code: 'llm_http', message: 'Could not reach Groq. Check your internet connection.' } satisfies AppError;
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
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch {
            if (signal.aborted) throw abortedError();
            throw {
              code: 'llm_http',
              message: 'The connection to Groq dropped while the answer was streaming.',
            } satisfies AppError;
          }
          if (signal.aborted) throw abortedError();
          const { done, value } = chunk;
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const { deltas, rest, usage, error, done: streamDone } = parseSSEChunk(buf);
          buf = rest;
          if (usage) sseUsage = usage;
          for (const delta of deltas) emit(delta);
          if (error) throw streamError(error);
          if (streamDone) break;
        }
      } finally {
        // [DONE] ends the answer even if the server keeps the connection open.
        // Also release the response when an SSE error terminates generation.
        await reader.cancel().catch(() => {});
        reader.releaseLock();
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
      if (tail.error) throw streamError(tail.error);
      if (signal.aborted) throw abortedError();
      if (!full.trim()) {
        throw {
          code: 'llm_http',
          message: 'Groq returned no answer text. Try again or choose another Groq model in Settings.',
        } satisfies AppError;
      }

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

function streamError(error: SseError): AppError {
  if (error.code === 'rate_limit_exceeded' || error.type === 'rate_limit_error') {
    return httpError(429, '', '');
  }
  const detail = typeof error.message === 'string' ? error.message.slice(0, 300).trim() : '';
  return {
    code: 'llm_http',
    message: detail ? `Groq could not finish the answer: ${detail}` : 'Groq could not finish the answer. Try again.',
  };
}

function httpError(status: number, body: string, model: string): AppError {
  if (status === 401) {
    return { code: 'llm_auth', message: `Groq rejected the API key (HTTP ${status}). Check it in Settings.` };
  }
  if (status === 403) {
    return {
      code: 'llm_auth',
      message: `Groq denied access to "${model}" (HTTP 403). Check your Groq model permissions or choose another model in Settings.`,
    };
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

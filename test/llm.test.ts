import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AppError } from '../src/shared/types';
import { createAnthropicProvider } from '../src/main/llm/anthropic';
import { createGroqProvider } from '../src/main/llm/groq';
import { buildSystemPrompt, buildSystemPromptBlocks } from '../src/main/prompt';

// These tests stub global fetch rather than mocking the Anthropic SDK, so the
// real SDK does the real work: it parses the real SSE wire format and throws its
// real error classes. That matters here, because the bug this file exists to pin
// is entirely about the SDK's error *hierarchy* — a mocked SDK would have
// happily reproduced whatever hierarchy the mock invented.

afterEach(() => {
  vi.unstubAllGlobals();
});

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A well-formed Anthropic streaming response. Each inner array is one text block's deltas. */
function anthropicStream(blocks: string[][]): Response {
  let body = sseEvent('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  blocks.forEach((deltas, index) => {
    body += sseEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '', citations: null },
    });
    for (const text of deltas) {
      body += sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text },
      });
    }
    body += sseEvent('content_block_stop', { type: 'content_block_stop', index });
  });
  body += sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  body += sseEvent('message_stop', { type: 'message_stop' });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function apiError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function abortError(): DOMException {
  return new DOMException('This operation was aborted', 'AbortError');
}

/** Captures the AppError thrown by a provider. Fails loudly if it resolves instead. */
async function catchError(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (err) {
    return err as AppError;
  }
  throw new Error('expected the provider to throw, but it resolved');
}

const anthropic = () => createAnthropicProvider('sk-test', 'resume', 'jd', 'balanced');
const groq = () => createGroqProvider('gsk-test', 'resume', 'jd', 'balanced');
const noop = (): void => {};

/** Signature for fetch mocks whose recorded calls the test inspects. */
type FetchArgs = [input: string | URL | Request, init?: RequestInit];

describe('anthropic provider — happy path', () => {
  test('streams deltas and returns exactly what was streamed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicStream([['Hello', ', ', 'world']])));
    const deltas: string[] = [];
    const full = await anthropic().generate('q', (d) => deltas.push(d), new AbortController().signal);

    expect(deltas).toEqual(['Hello', ', ', 'world']);
    expect(full).toBe('Hello, world');
    expect(full).toBe(deltas.join(''));
  });

  // Regression: stream.finalText() joins text blocks with a SPACE. If this
  // provider ever switches to it, the answer handed to the renderer would gain a
  // space that was never streamed, and this assertion would catch it.
  test('a multi-block answer returns the streamed concatenation, with no injected separator', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicStream([['one'], ['two']])));
    const deltas: string[] = [];
    const full = await anthropic().generate('q', (d) => deltas.push(d), new AbortController().signal);

    expect(full).toBe('onetwo');
    expect(full).toBe(deltas.join(''));
    expect(full).not.toContain(' ');
  });

  test('sends the resume+JD as a cached block and the style as a separate uncached block', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => anthropicStream([['ok']]));
    vi.stubGlobal('fetch', fetchMock);
    await anthropic().generate('q', noop, new AbortController().signal);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.system).toHaveLength(2);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0].text).toContain('resume');
    // The volatile block must NOT carry a breakpoint, or the style would be
    // part of the cached prefix and toggling it would bust the cache.
    expect(body.system[1].cache_control).toBeUndefined();
    expect(body.model).toBe('claude-haiku-4-5');
  });

  test('sends personalization and follow-up context while keeping style outside the cached prefix', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => anthropicStream([['Example']]));
    vi.stubGlobal('fetch', fetchMock);
    const personalization = { personalProfile: 'I write Python APIs.', customInstructions: 'Use backend examples.' };
    const provider = createAnthropicProvider('sk-test', 'resume', 'jd', 'brief', 'claude-haiku-4-5', personalization);
    await provider.generate('Show a Python example.', noop, new AbortController().signal, undefined, {
      answerStyle: 'detailed',
      context: [{ question: 'Explain caching.', answer: 'Reuse a stored result.' }],
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const expected = buildSystemPromptBlocks('resume', 'jd', 'detailed', personalization);
    expect(body.system[0]).toMatchObject({ text: expected.cachedPrefix, cache_control: { type: 'ephemeral' } });
    expect(body.system[0].text).toContain(personalization.personalProfile);
    expect(body.system[0].text).toContain(personalization.customInstructions);
    expect(body.system[1]).toEqual({ type: 'text', text: expected.styleSuffix });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['user']);
    expect(body.messages[0].content).toContain('Explain caching.');
    expect(body.messages[0].content).toContain('Reuse a stored result.');
    expect(body.messages[0].content).toContain('unconfirmed generated suggestions');
    expect(body.messages[0].content).toContain('Show a Python example.');
    expect(body.max_tokens).toBe(2048);

    await provider.generate('Next question', noop, new AbortController().signal);
    const nextBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(nextBody.system[0]).toEqual(body.system[0]);
    expect(nextBody.system[1].text).toBe(buildSystemPromptBlocks('resume', 'jd', 'brief', personalization).styleSuffix);
    expect(nextBody.messages).toHaveLength(1);
    expect(nextBody.max_tokens).toBe(1024);
  });
});

describe('anthropic provider — error mapping', () => {
  test('401 maps to llm_auth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiError(401, 'authentication_error', 'invalid x-api-key')));
    const err = await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_auth');
    expect(err.message).toMatch(/Settings/);
  });

  test('403 maps to llm_auth and names the model the key cannot use', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiError(403, 'permission_error', 'not allowed')));
    const err = await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_auth');
    expect(err.message).toContain('403');
    expect(err.message).toContain('claude-haiku-4-5');
  });

  test('429 maps to llm_rate_limit with actionable advice, not llm_http', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiError(429, 'rate_limit_error', 'slow down')));
    const err = await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_rate_limit');
    expect(err.message).toMatch(/wait a few seconds|credit balance/i);
  });

  test('529 overloaded maps to llm_http with a retry hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiError(529, 'overloaded_error', 'overloaded')));
    const err = await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toMatch(/overloaded/i);
  });

  test('400 maps to llm_http and keeps the status visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiError(400, 'invalid_request_error', 'bad model')));
    const err = await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toContain('400');
  });

  test('404 maps to llm_http with the status visible (model retired out from under us)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiError(404, 'not_found_error', 'model not found')));
    const err = await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toContain('404');
  });

  // 500 must reach the generic HTTP branch, not the retry: with maxRetries: 0
  // and our own retry scoped to connection errors, a server error is reported
  // on the first attempt.
  test('500 maps to llm_http with the status visible, without a retry', async () => {
    const fetchMock = vi.fn(async () => apiError(500, 'api_error', 'internal error'));
    vi.stubGlobal('fetch', fetchMock);
    const err = await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toContain('500');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Precedence: once the caller aborted, whatever error the SDK happened to be
  // holding (here a 500) is noise — the session manager shows nothing for
  // 'aborted', and that is what the user who pressed record again expects.
  test('an abort wins over a concurrent HTTP error', async () => {
    const ac = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        ac.abort();
        return apiError(500, 'api_error', 'internal error');
      }),
    );
    const err = await catchError(() => anthropic().generate('q', noop, ac.signal));
    expect(err.code).toBe('aborted');
  });

  // The headline regression. APIUserAbortError extends APIError with
  // status === undefined, so an `instanceof APIError` branch placed before the
  // abort check turns "user pressed record again" into
  // "Answer generation failed (HTTP undefined)".
  test('an abort maps to aborted, never to an HTTP-undefined error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.signal?.aborted) throw abortError();
        return anthropicStream([['never']]);
      }),
    );
    const ac = new AbortController();
    ac.abort();

    const err = await catchError(() => anthropic().generate('q', noop, ac.signal));
    expect(err.code).toBe('aborted');
    expect(err.message).not.toMatch(/undefined/);
    expect(err.message).not.toMatch(/HTTP/);
  });

  test('a network failure is a clean message, not a raw TypeError or HTTP undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const err = await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toMatch(/Could not reach Anthropic/);
    expect(err.message).not.toMatch(/undefined/);
  });
});

describe('anthropic provider — single retry on connection failure', () => {
  test('retries once and succeeds when the connection drops before any token', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('fetch failed');
        return anthropicStream([['recovered']]);
      }),
    );
    const deltas: string[] = [];
    const full = await anthropic().generate('q', (d) => deltas.push(d), new AbortController().signal);

    expect(calls).toBe(2);
    expect(full).toBe('recovered');
    expect(deltas).toEqual(['recovered']); // exactly one answer on screen
  });

  test('retries at most once, then reports the error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err.code).toBe('llm_http');
  });

  test('does not retry a request aborted in flight', async () => {
    const ac = new AbortController();
    // The request starts, then the session cancels it (user hit record again).
    const fetchMock = vi.fn(async () => {
      ac.abort();
      throw abortError();
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await catchError(() => anthropic().generate('q', noop, ac.signal));
    expect(err.code).toBe('aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1); // a retry here would race the new session
  });

  test('does not retry an HTTP error — that would burn the first-token budget', async () => {
    const fetchMock = vi.fn(async () => apiError(429, 'rate_limit_error', 'slow down'));
    vi.stubGlobal('fetch', fetchMock);

    await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('never retries after a delta reached the panel, which would duplicate the answer', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        // Stream a delta, then cut the connection mid-block (no message_stop).
        const partial =
          sseEvent('message_start', {
            type: 'message_start',
            message: {
              id: 'm',
              type: 'message',
              role: 'assistant',
              model: 'claude-haiku-4-5',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          }) +
          sseEvent('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '', citations: null },
          }) +
          sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'half' },
          });
        return new Response(partial, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }),
    );

    const deltas: string[] = [];
    await catchError(() => anthropic().generate('q', (d) => deltas.push(d), new AbortController().signal));
    expect(calls).toBe(1);
    expect(deltas).toEqual(['half']); // not ['half', 'half']
  });
});

describe('groq provider', () => {
  function groqStream(body: string): Response {
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  function groqLine(content: string): string {
    return 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n';
  }

  test('streams deltas and returns the concatenation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => groqStream(groqLine('Hi') + groqLine(' there') + 'data: [DONE]\n\n')),
    );
    const deltas: string[] = [];
    const full = await groq().generate('q', (d) => deltas.push(d), new AbortController().signal);

    expect(deltas).toEqual(['Hi', ' there']);
    expect(full).toBe('Hi there');
  });

  // Regression: without the end-of-stream flush the last delta stayed stuck in
  // the parser's leftover buffer and the user silently lost the end of the answer.
  test('does not drop the last delta when the stream ends without a trailing newline', async () => {
    const truncated = groqLine('Start') + 'data: ' + JSON.stringify({ choices: [{ delta: { content: ' END' } }] });
    vi.stubGlobal('fetch', vi.fn(async () => groqStream(truncated)));
    const deltas: string[] = [];
    const full = await groq().generate('q', (d) => deltas.push(d), new AbortController().signal);

    expect(deltas).toEqual(['Start', ' END']);
    expect(full).toBe('Start END');
  });

  test('pins the model to a non-deprecated id and suppresses reasoning for latency', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => groqStream(groqLine('x') + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    await groq().generate('q', noop, new AbortController().signal);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.model).not.toBe('llama-3.3-70b-versatile'); // shut down 2026-08-16
    expect(body.model).toBe('openai/gpt-oss-120b');
    expect(body.include_reasoning).toBe(false);
    expect(body.reasoning_effort).toBe('low');
    expect(body.stream).toBe(true);
  });

  // Parity with anthropic.ts's MAX_TOKENS: spoken answers are short, and an
  // uncapped runaway completion is pure tail latency.
  test('caps the completion length so a runaway answer cannot stream forever', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => groqStream(groqLine('x') + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    await groq().generate('q', noop, new AbortController().signal);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.max_completion_tokens).toBe(2048);
  });

  // Our TextDecoder path, not the parser's: decode(value, {stream: true}) must
  // hold back a half-received multi-byte sequence instead of emitting U+FFFD.
  // Delivering the body one byte at a time guarantees every multi-byte char in
  // the payload is split across reads.
  test('multi-byte UTF-8 split across network chunks is reassembled, not corrupted', async () => {
    const bytes = new TextEncoder().encode(groqLine('café — ☕') + 'data: [DONE]\n\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );

    const deltas: string[] = [];
    const full = await groq().generate('q', (d) => deltas.push(d), new AbortController().signal);
    expect(full).toBe('café — ☕');
    expect(full).not.toContain('�');
    expect(deltas.join('')).toBe(full);
  });

  test('401 maps to llm_auth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_auth');
    expect(err.message).toContain('401');
  });

  test('403 maps to llm_auth and reports 403, not a misleading 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_auth');
    expect(err.message).toContain('403');
    expect(err.message).not.toContain('401');
  });

  test('429 maps to llm_rate_limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));
    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_rate_limit');
  });

  test('404 points at the pinned model, the likeliest cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no such model', { status: 404 })));
    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toMatch(/retired|model/i);
  });

  test('5xx maps to llm_http with a retry hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toMatch(/unavailable/i);
  });

  test('500 maps to llm_http with the status visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toContain('500');
  });

  test('an unmapped 4xx keeps the status and a body snippet for debugging', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('json parse failure', { status: 422 })));
    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toContain('422');
    expect(err.message).toContain('json parse failure');
  });

  // Regression: this used to be `res.body!.getReader()`, which threw a raw
  // "Cannot read properties of null" TypeError at the user.
  test('a 200 with no body is a clean error, not a TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toMatch(/empty response body/i);
    expect(err.message).not.toMatch(/Cannot read propert/);
  });

  test('an abort during the request maps to aborted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.signal?.aborted) throw abortError();
        return groqStream(groqLine('x'));
      }),
    );
    const ac = new AbortController();
    ac.abort();

    const err = await catchError(() => groq().generate('q', noop, ac.signal));
    expect(err.code).toBe('aborted');
  });

  test('an abort mid-stream maps to aborted, not a scary network error', async () => {
    const ac = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(groqLine('first')));
                // The session cancelled us while the answer was still streaming.
                ac.abort();
                controller.error(abortError());
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );

    const err = await catchError(() => groq().generate('q', noop, ac.signal));
    expect(err.code).toBe('aborted');
  });

  test('a connection drop mid-stream is a clean llm_http message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(groqLine('first')));
                controller.error(new TypeError('terminated'));
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );

    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toMatch(/dropped/i);
  });

  test('finishes on DONE without waiting for the server to close the connection', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(groqLine('Complete') + 'data: [DONE]\n\n'));
      },
      cancel,
    }), { headers: { 'content-type': 'text/event-stream' } })));
    expect(await groq().generate('q', noop, new AbortController().signal)).toBe('Complete');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('gives a typed follow-up room for examples even when the saved style is brief', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => groqStream(groqLine('Example') + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    await createGroqProvider('gsk-test', '', '', 'brief').generate(
      'Show me a Python example.', noop, new AbortController().signal, undefined,
      { context: [{ question: 'Explain caching.', answer: 'Store reusable results.' }] },
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.messages[1].content).toContain('Show me a Python example.');
  });

  test('maps a rate-limit event received after HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => groqStream('data: {"error":{"code":"rate_limit_exceeded"}}\n\n')));
    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_rate_limit');
  });

  test.each(['\n\n', ''])('surfaces an SSE error after partial text with ending %j', async (ending) => {
    const body = groqLine('Partial answer') + 'data: {"error":{"message":"Generation failed","code":"server_error"}}' + ending;
    const fetchMock = vi.fn(async () => groqStream(body));
    vi.stubGlobal('fetch', fetchMock);
    const deltas: string[] = [];
    const err = await catchError(() => groq().generate('q', (d) => deltas.push(d), new AbortController().signal));
    expect(err).toMatchObject({ code: 'llm_http', message: expect.stringContaining('Generation failed') });
    expect(deltas).toEqual(['Partial answer']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each(['', 'data: [DONE]\n\n', 'data: {not json}\n\n', groqLine('   ')])(
    'rejects an HTTP 200 stream without answer text (%j)', async (body) => {
      vi.stubGlobal('fetch', vi.fn(async () => groqStream(body)));
      const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
      expect(err.code).toBe('llm_http');
      expect(err.message).toMatch(/no answer text/i);
    },
  );

  test('sends personalization and labeled conversation data for a detailed follow-up', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => groqStream(groqLine('x') + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    const personalization = { personalProfile: 'I build Python APIs.', customInstructions: 'Use practical backend examples.' };
    const provider = createGroqProvider('gsk-test', 'resume', 'jd', 'brief', 'openai/gpt-oss-120b', personalization);
    await provider.generate('Show an example.', noop, new AbortController().signal, undefined, {
      answerStyle: 'detailed',
      context: [{ question: 'What is idempotency?', answer: 'Repeated requests have the same effect.' }],
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(body.messages[0].content).toBe(buildSystemPrompt('resume', 'jd', 'detailed', personalization));
    expect(body.messages[0].content).toContain(personalization.personalProfile);
    expect(body.messages[0].content).toContain(personalization.customInstructions);
    expect(body.messages[1].content).toContain('What is idempotency?');
    expect(body.messages[1].content).toContain('Repeated requests have the same effect.');
    expect(body.messages[1].content).toContain('unconfirmed generated suggestions');
    expect(body.messages[1].content).toContain('Show an example.');
    expect(body.max_completion_tokens).toBe(4096);

    // A request-specific expansion must not turn later initial answers detailed.
    await provider.generate('Next question', noop, new AbortController().signal);
    const nextBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(nextBody.messages[0].content).toBe(buildSystemPrompt('resume', 'jd', 'brief', personalization));
    expect(nextBody.messages).toHaveLength(2);
    expect(nextBody.max_completion_tokens).toBe(2048);
  });

  test('caps completion length with room for hidden reasoning and visible answer text', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => groqStream(groqLine('x') + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    await groq().generate('q', noop, new AbortController().signal);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.max_completion_tokens).toBe(2048);
  });

  test('uses the default public model and suppresses reasoning for latency', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => groqStream(groqLine('x') + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    await groq().generate('q', noop, new AbortController().signal);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('openai/gpt-oss-120b');
    expect(body.include_reasoning).toBe(false);
    expect(body.reasoning_effort).toBe('low');
    expect(body.stream).toBe(true);
  });
});

describe('groq provider — single retry on connection failure', () => {
  function groqStream(body: string): Response {
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  function groqLine(content: string): string {
    return 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n';
  }

  test('retries once and succeeds when the initial fetch rejects', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('fetch failed');
        return groqStream(groqLine('recovered') + 'data: [DONE]\n\n');
      }),
    );
    const deltas: string[] = [];
    const full = await groq().generate('q', (d) => deltas.push(d), new AbortController().signal);

    expect(calls).toBe(2);
    expect(full).toBe('recovered');
    expect(deltas).toEqual(['recovered']); // exactly one answer on screen
  });

  test('retries at most once, then reports a clean connection error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err.code).toBe('llm_http');
    expect(err.message).toMatch(/Could not reach Groq/);
  });

  test('re-sends a byte-identical request body on the retry', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (..._args: FetchArgs) => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return groqStream(groqLine('ok') + 'data: [DONE]\n\n');
    });
    vi.stubGlobal('fetch', fetchMock);
    await groq().generate('q', noop, new AbortController().signal);

    const first = (fetchMock.mock.calls[0]?.[1] as RequestInit).body;
    const second = (fetchMock.mock.calls[1]?.[1] as RequestInit).body;
    expect(second).toBe(first);
  });

  test('does not retry a request aborted in flight', async () => {
    const ac = new AbortController();
    // The request starts, then the session cancels it (user hit record again).
    const fetchMock = vi.fn(async () => {
      ac.abort();
      throw abortError();
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await catchError(() => groq().generate('q', noop, ac.signal));
    expect(err.code).toBe('aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1); // a retry here would race the new session
  });

  test('does not retry an HTTP error status — the server heard us and said no', async () => {
    const fetchMock = vi.fn(async () => new Response('slow down', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not retry a 5xx either', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('never retries a mid-stream drop after a delta reached the panel', async () => {
    // The retry is scoped to the initial fetch rejection. Once the response
    // body is streaming, a second attempt would concatenate two answers in the
    // renderer, which appends deltas as they arrive. Pull-based so the first
    // chunk is actually delivered (and painted) before the connection dies —
    // erroring synchronously in start() would discard the queued chunk.
    let pulls = 0;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) controller.enqueue(new TextEncoder().encode(groqLine('half')));
              else controller.error(new TypeError('terminated'));
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const deltas: string[] = [];
    const err = await catchError(() => groq().generate('q', (d) => deltas.push(d), new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deltas).toEqual(['half']); // not ['half', 'half']
  });

  test('an abort that arrives between the two attempts maps to aborted, not llm_http', async () => {
    const ac = new AbortController();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed'); // genuine network failure...
      ac.abort(); // ...but the user cancels while the retry is in flight
      throw abortError();
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await catchError(() => groq().generate('q', noop, ac.signal));
    expect(err.code).toBe('aborted');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('provider context parity', () => {
  test('both providers send identical context instructions and bounded explicit follow-up data', async () => {
    const { legacyContext, buildSystemPromptBlocks, buildUserMessage } = await import('../src/main/prompt');
    const snapshot = legacyContext('Supported experience', 'Role context', 'brief');
    snapshot.situation = 'client';
    snapshot.background = 'Supported product facts';
    snapshot.instructions = 'Offer a practical next step';
    snapshot.output = { answerStyle: 'brief', format: 'talking-points', tone: 'diplomatic', audience: 'nontechnical' };
    snapshot.questionNote = 'Do not promise a deadline';
    snapshot.relatedAnswer = { question: 'Can you deliver?', answer: 'An earlier unconfirmed suggestion' };
    snapshot.refinement = 'Make it clearer';
    const fetchMock = vi.fn(async (..._args: FetchArgs) => anthropicStream([['ok']]));
    vi.stubGlobal('fetch', fetchMock);
    await createAnthropicProvider('key', snapshot).generate('What next?', noop, new AbortController().signal);
    const anthropicBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    fetchMock.mockImplementation(async () => new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }));
    await createGroqProvider('key', snapshot).generate('What next?', noop, new AbortController().signal);
    const groqBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const blocks = buildSystemPromptBlocks(snapshot);
    expect(anthropicBody.system).toEqual([
      { type: 'text', text: blocks.cachedPrefix, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: blocks.styleSuffix },
    ]);
    expect(groqBody.messages[0]).toEqual({ role: 'system', content: blocks.cachedPrefix + '\n\n' + blocks.styleSuffix });
    expect(anthropicBody.messages).toEqual(groqBody.messages.slice(1));
    expect(anthropicBody.messages).toEqual([{ role: 'user', content: buildUserMessage('What next?', snapshot) }]);
    expect(anthropicBody.messages[0].content).toContain('unconfirmed generated suggestion');
    expect(anthropicBody.system[0].text).not.toContain('Do not promise a deadline');
    expect(anthropicBody.system[0].text).not.toContain('An earlier unconfirmed suggestion');
  });
});

describe('model selection and usage reporting', () => {
  function groqStream(body: string): Response {
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  function groqLine(content: string): string {
    return 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n';
  }

  test('anthropic: the default model sends NO thinking parameter (Haiku predates it)', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => anthropicStream([['x']]));
    vi.stubGlobal('fetch', fetchMock);
    await anthropic().generate('q', noop, new AbortController().signal);
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.thinking).toBeUndefined();
  });

  test('anthropic: a model override reaches the body and disables default-on thinking', async () => {
    // Sonnet 5 / Opus 5 think by default; left alone they would spend the
    // first-token budget reasoning. The provider must explicitly turn it off.
    const fetchMock = vi.fn(async (..._args: FetchArgs) => anthropicStream([['x']]));
    vi.stubGlobal('fetch', fetchMock);
    await createAnthropicProvider('sk-test', 'resume', 'jd', 'balanced', 'claude-sonnet-5').generate(
      'q',
      noop,
      new AbortController().signal,
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  test('anthropic: reports usage with a cost estimate for a pinned-pricing model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicStream([['hi']])));
    let usage: import('../src/shared/types').AnswerUsage | undefined;
    await anthropic().generate('q', noop, new AbortController().signal, (u) => {
      usage = u;
    });
    // anthropicStream reports input 10 (message_start) and output 5 (message_delta).
    expect(usage).toMatchObject({
      model: 'claude-haiku-4-5',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(usage!.estCostUsd).toBeCloseTo((10 * 1 + 5 * 5) / 1e6, 12);
  });

  test('groq: asks for usage accounting on the final chunk', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => groqStream(groqLine('x') + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    await groq().generate('q', noop, new AbortController().signal);
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test('groq: a non-reasoning model gets no reasoning params (it would reject them)', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => groqStream(groqLine('x') + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    await createGroqProvider('gsk-test', 'resume', 'jd', 'balanced', 'llama-3.1-8b-instant').generate(
      'q',
      noop,
      new AbortController().signal,
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.model).toBe('llama-3.1-8b-instant');
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.include_reasoning).toBeUndefined();
  });

  test('groq: usage from the final chunk reaches onUsage — tokens only, no invented cost', async () => {
    const usageChunk =
      'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }) + '\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => groqStream(groqLine('hi') + usageChunk + 'data: [DONE]\n\n')));
    let usage: import('../src/shared/types').AnswerUsage | undefined;
    await groq().generate('q', noop, new AbortController().signal, (u) => {
      usage = u;
    });
    expect(usage).toEqual({
      model: 'openai/gpt-oss-120b',
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(usage!.estCostUsd).toBeUndefined();
  });

  test('groq: a stream with no usage chunk simply never calls onUsage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => groqStream(groqLine('hi') + 'data: [DONE]\n\n')));
    const onUsage = vi.fn();
    await groq().generate('q', noop, new AbortController().signal, onUsage);
    expect(onUsage).not.toHaveBeenCalled();
  });
});

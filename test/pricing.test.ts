import { describe, expect, test } from 'vitest';
import { estimateCostUsd } from '../src/main/llm/pricing';

const zeroCache = { cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('estimateCostUsd', () => {
  test('prices a typical Haiku answer (the default model) correctly', () => {
    // 1500 in @ $1/MTok + 300 out @ $5/MTok = $0.0015 + $0.0015
    const usd = estimateCostUsd('claude-haiku-4-5', { inputTokens: 1500, outputTokens: 300, ...zeroCache });
    expect(usd).toBeCloseTo(0.003, 10);
  });

  test('scales with the model tier — the same answer costs 3x/5x on Sonnet/Opus input', () => {
    const t = { inputTokens: 1_000_000, outputTokens: 0, ...zeroCache };
    expect(estimateCostUsd('claude-haiku-4-5', t)).toBeCloseTo(1, 10);
    expect(estimateCostUsd('claude-sonnet-5', t)).toBeCloseTo(3, 10);
    expect(estimateCostUsd('claude-opus-5', t)).toBeCloseTo(5, 10);
  });

  test('output tokens are priced at the output rate, not the input rate', () => {
    const usd = estimateCostUsd('claude-opus-5', { inputTokens: 0, outputTokens: 1_000_000, ...zeroCache });
    expect(usd).toBeCloseTo(25, 10);
  });

  test('cache reads bill at 0.1x input and writes at 1.25x input', () => {
    const read = estimateCostUsd('claude-haiku-4-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    });
    expect(read).toBeCloseTo(0.1, 10);
    const write = estimateCostUsd('claude-haiku-4-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_000_000,
    });
    expect(write).toBeCloseTo(1.25, 10);
  });

  test('all four buckets are summed — cache tokens are NOT inside inputTokens', () => {
    // The API reports them separately; double-counting or dropping either
    // would silently skew every estimate.
    const usd = estimateCostUsd('claude-haiku-4-5', {
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheReadTokens: 200_000,
      cacheWriteTokens: 50_000,
    });
    const expected = (100_000 + 50_000 * 1.25 + 200_000 * 0.1) / 1e6 + (10_000 * 5) / 1e6;
    expect(usd).toBeCloseTo(expected, 10);
  });

  test('returns undefined for a model whose pricing is not pinned (never guesses)', () => {
    expect(estimateCostUsd('openai/gpt-oss-120b', { inputTokens: 100, outputTokens: 10, ...zeroCache })).toBeUndefined();
    expect(estimateCostUsd('some-future-model', { inputTokens: 100, outputTokens: 10, ...zeroCache })).toBeUndefined();
  });

  test('a zero-token answer costs exactly zero, not NaN', () => {
    expect(estimateCostUsd('claude-haiku-4-5', { inputTokens: 0, outputTokens: 0, ...zeroCache })).toBe(0);
  });
});

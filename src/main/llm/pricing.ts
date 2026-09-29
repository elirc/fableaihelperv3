// Pinned per-MTok pricing for the models the Settings picker offers, so each
// answer can carry an honest cost estimate. Anthropic-only on purpose: Groq's
// pricing is not pinned in this repo (see README), and a wrong number is worse
// than no number — providers without an entry simply show token counts.
//
// Prices verified 2026-08-20 against the Anthropic pricing table:
//   Haiku 4.5  $1 / $5     Sonnet 5  $3 / $15 (intro $2/$10 ends 2026-08-31 —
//   the standard rate is pinned so estimates do not silently drop next month)
//   Opus 5     $5 / $25
// Cache multipliers are uniform across models: writes 1.25x input, reads 0.1x.

interface ModelPricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

const PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Estimated cost of one answer in USD, or undefined when the model's pricing
 * is not pinned here. Cache reads/writes are billed at their own rates and are
 * NOT included in inputTokens by the API, so all four buckets are summed.
 */
export function estimateCostUsd(model: string, t: TokenCounts): number | undefined {
  const p = PRICING[model];
  if (!p) return undefined;
  const inputUsd =
    (t.inputTokens +
      t.cacheWriteTokens * CACHE_WRITE_MULTIPLIER +
      t.cacheReadTokens * CACHE_READ_MULTIPLIER) *
    (p.inputPerMTok / 1_000_000);
  const outputUsd = t.outputTokens * (p.outputPerMTok / 1_000_000);
  return inputUsd + outputUsd;
}

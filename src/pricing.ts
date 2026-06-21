import { FALLBACK_RATE, PRICING } from "./consts.js";

/**
 * USD cost for a request. Never throws — a missing price never breaks the wrapped
 * call. An unknown model falls back to a deliberately HIGH conservative rate (not
 * $0) and reports loudly via onError, so budgets still trip for un-priced models.
 * Add the real row to PRICING in consts.ts for accurate accounting.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  onError?: (err: Error) => void,
): number {
  const rate = PRICING[model];
  if (!rate) {
    const err = new Error(
      `agenthelm: no pricing for model "${model}" — using conservative fallback rate so budgets still apply. Add it to PRICING for accuracy.`,
    );
    if (onError) onError(err);
    else console.warn(err.message);
    return inputTokens * FALLBACK_RATE.input_per_token + outputTokens * FALLBACK_RATE.output_per_token;
  }
  return inputTokens * rate.input_per_token + outputTokens * rate.output_per_token;
}

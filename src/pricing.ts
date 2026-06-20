import { PRICING } from "./consts.js";

/**
 * USD cost for a request. Unknown model returns 0 and reports via onError
 * (or console) — never throws, so a missing price never breaks the wrapped call.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  onError?: (err: Error) => void,
): number {
  const rate = PRICING[model];
  if (!rate) {
    const err = new Error(`agenthelm: no pricing for model "${model}", cost recorded as 0`);
    if (onError) onError(err);
    else console.warn(err.message);
    return 0;
  }
  return inputTokens * rate.input_per_token + outputTokens * rate.output_per_token;
}

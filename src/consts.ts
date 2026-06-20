// All tunable constants for the SDK live here.
import type { ModelRate } from "./types.js";

/** Stamped onto every telemetry event. Keep in sync with package.json. */
export const SDK_VERSION = "0.1.0";

/** Where batched telemetry is POSTed unless the caller overrides it. */
export const DEFAULT_ENDPOINT = "https://api.agenthelm.dev/v1/events";

/** Flush the queue at least this often (ms). */
export const DEFAULT_FLUSH_INTERVAL = 5000;

/** Flush early once this many events are buffered. */
export const DEFAULT_BATCH_SIZE = 50;

/** How long a fetched kill-status is trusted before re-checking (ms). */
export const KILL_CACHE_MS = 10_000;

const PER_MILLION = 1_000_000;
const rate = (inputPerM: number, outputPerM: number): ModelRate => ({
  input_per_token: inputPerM / PER_MILLION,
  output_per_token: outputPerM / PER_MILLION,
});

/**
 * USD cost per token by exact model id, derived from per-1M list prices.
 * Add a row as providers ship models.
 */
export const PRICING: Record<string, ModelRate> = {
  // OpenAI
  "gpt-4o": rate(2.5, 10),
  "gpt-4o-mini": rate(0.15, 0.6),
  "gpt-4-turbo": rate(10, 30),
  "gpt-4": rate(30, 60),
  "gpt-3.5-turbo": rate(0.5, 1.5),
  // Anthropic (forward-compat; harmless until Anthropic support lands)
  "claude-sonnet-4-6": rate(3, 15),
  "claude-opus-4": rate(15, 75),
  "claude-haiku-3-5": rate(0.8, 4),
};

import type { RoutePolicy } from "./router.js";
import type { CacheOptions } from "./cache.js";

/**
 * Privacy-safe summary of a prompt. No raw content — just shape and a one-way
 * hash, enough to diagnose token waste (bloat, loops, fat system prompts).
 */
export interface PromptFingerprint {
  /** Number of messages in the request. */
  message_count: number;
  /** Total character size across all message content. */
  total_chars: number;
  /** Per-role breakdown: message count and character size. */
  roles: Record<string, { count: number; chars: number }>;
  /** SHA-256 of the message array; identical prompts collide, content is not recoverable. */
  hash: string;
}

/** A single usage record shipped to the telemetry endpoint. Never contains raw prompts, completions, or keys. */
export interface TelemetryEvent {
  agent_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  timestamp: string;
  sdk_version: string;
  stream: boolean;
  /** Prompt shape/hash for diagnosing waste. Absent when messages aren't an array. */
  prompt?: PromptFingerprint;
  /** Names of tools the model called on this response. Names only — never arguments. Absent when none. */
  tool_calls?: string[];
  /** One-way hash of the output (completion / tool-call JSON). Content-free; detects a stuck model. Absent when no output. */
  output_hash?: string;
  /** Set when the router sent the call to a different model than requested. */
  routing?: { from: string; to: string; rule: string | null; fallback: boolean };
  /** Present only on a cache hit (the LLM call was skipped). */
  cache?: { hit: boolean };
  /** Advanced features active on this client, e.g. ["routing","cache"]. */
  sdk_features?: string[];
}

export interface MonitorOptions {
  /** Identifies which agent the wrapped client belongs to. */
  agentId: string;
  /** Bearer token for the telemetry endpoint. */
  accKey: string;
  /** Telemetry ingest URL. Defaults to the hosted endpoint. */
  endpoint?: string;
  /** Flush the queue at least this often (ms). Default 5000. */
  flushInterval?: number;
  /** Flush early once this many events are buffered. Default 50. */
  batchSize?: number;
  /**
   * Before each call, check whether this agent has been killed (it's killed only
   * when you've set a budget + auto-stop in the dashboard and spend crossed it).
   * On a kill: if `onKilled` is set it runs and its value is returned; otherwise
   * an `AgentKilledError` is thrown. Adds a cached status lookup. **Default true.**
   * With no budget configured the backend never reports a kill, so this stays inert.
   */
  killCheck?: boolean;
  /**
   * Runs instead of throwing when a killed agent's call is blocked. Return a
   * fallback value to use as the response so one killed (sub)agent degrades
   * gracefully rather than throwing into — and possibly crashing — the host.
   * If omitted, a blocked call throws `AgentKilledError`.
   */
  onKilled?: (info: KillInfo) => unknown;
  /** Called when telemetry dispatch or cost lookup fails. Swallowed by default. */
  onError?: (err: Error) => void;
}

/** Details passed to `onKilled` when a killed agent's request is blocked. */
export interface KillInfo {
  agentId: string;
  model: string;
}

/**
 * `MonitorOptions` plus the opt-in cost-reduction features. Backward compatible:
 * `{ agentId, accKey }` alone still works. `router`/`cache` currently take effect
 * on the OpenAI adapter (`withCostControl`); other adapters record telemetry only.
 */
export interface AdvancedOptions extends MonitorOptions {
  /** Model routing. A policy object, the "auto" heuristic, or false/undefined to disable. */
  router?: RoutePolicy | "auto" | false;
  /** Exact-match response cache (memory or BYODB Redis/Upstash). Opt-in. */
  cache?: CacheOptions;
}

/**
 * Config the backend can push down via the status endpoint (alongside kill state).
 * Lets the dashboard / auto-remediation steer the SDK without a new poll.
 */
export interface RemoteConfig {
  routing?: RoutePolicy | "auto";
  /** Cache backend pushed from the dashboard (managed proxy or BYODB creds). */
  cache?: CacheOptions;
}

/** Internal resolved config — all defaults filled in. */
export interface ResolvedOptions extends Required<Omit<MonitorOptions, "onError" | "onKilled">> {
  onError: (err: Error) => void;
  onKilled?: (info: KillInfo) => unknown;
}

/** USD cost per single token for one model. */
export interface ModelRate {
  input_per_token: number;
  output_per_token: number;
}

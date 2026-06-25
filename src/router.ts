import { fingerprintMessages } from "./fingerprint.js";

/**
 * Model routing ("downshift"): send cheap/simple calls to a cheaper model and
 * keep expensive models for the hard ones. Pure and synchronous — no classifier,
 * no extra network call, so it never adds latency to the real LLM call. The model
 * actually used is what gets recorded, so cost telemetry reflects the routed model.
 */

/** A condition evaluated against the outgoing request. */
export type RouteCondition =
  | { type: "token_estimate"; max: number }
  | { type: "tool_count"; max: number };

/** One routing rule: when `condition` holds, route to `targetModel`. */
export interface RouteRule {
  name: string;
  condition: RouteCondition;
  targetModel: string;
  /** Higher priority rules are checked first. Defaults to 0. */
  priority?: number;
}

/** An explicit routing policy (a list of rules, highest priority first). */
export interface RoutePolicy {
  routes: RouteRule[];
}

/** Routing config a user (or the dashboard) supplies. `"auto"` = built-in heuristic. */
export type RouterOption = RoutePolicy | "auto" | false;

export interface RouteRequest {
  model: string;
  messages: unknown;
  toolCount: number;
}

export interface RoutingDecision {
  originalModel: string;
  selectedModel: string;
  ruleMatched: string | null;
  fallback: boolean;
}

/** Cheap heuristic token estimate (~4 chars/token). No tokenizer dependency. */
export function estimateTokens(messages: unknown): number {
  if (messages == null) return 0;
  const fp = fingerprintMessages(messages);
  if (fp) return Math.ceil(fp.total_chars / 4);
  try {
    return Math.ceil(JSON.stringify(messages).length / 4);
  } catch {
    return 0;
  }
}

/** Below this estimated token count (and with no tools) "auto" considers a call cheap. */
export const AUTO_MAX_TOKENS = 2000;

/** Cheapest sane sibling for each model, used by the "auto" heuristic. */
export const AUTO_DOWNSHIFT: Record<string, string> = {
  "gpt-4": "gpt-4o-mini",
  "gpt-4-turbo": "gpt-4o-mini",
  "gpt-4o": "gpt-4o-mini",
  "claude-opus-4": "claude-haiku-3-5",
  "claude-sonnet-4-6": "claude-haiku-3-5",
};

function matches(cond: RouteCondition, req: RouteRequest): boolean {
  switch (cond.type) {
    case "token_estimate":
      return estimateTokens(req.messages) <= cond.max;
    case "tool_count":
      return req.toolCount <= cond.max;
    default:
      return false;
  }
}

/**
 * Decide which model a call should use. Returns the original model unchanged when
 * nothing matches, so routing is always safe to leave on.
 */
export function route(policy: RoutePolicy | "auto", req: RouteRequest): RoutingDecision {
  const base: RoutingDecision = {
    originalModel: req.model,
    selectedModel: req.model,
    ruleMatched: null,
    fallback: false,
  };

  if (policy === "auto") {
    if (req.toolCount === 0 && estimateTokens(req.messages) < AUTO_MAX_TOKENS) {
      const cheap = AUTO_DOWNSHIFT[req.model];
      if (cheap && cheap !== req.model) {
        return { ...base, selectedModel: cheap, ruleMatched: "auto-downshift" };
      }
    }
    return base;
  }

  const rules = [...(policy.routes ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  for (const r of rules) {
    if (matches(r.condition, req)) {
      return { ...base, selectedModel: r.targetModel, ruleMatched: r.name };
    }
  }
  return base;
}

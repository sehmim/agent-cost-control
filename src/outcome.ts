import { DEFAULT_ENDPOINT } from "./consts.js";

/**
 * Outcome reporting — the "cost per successful completion" channel.
 *
 * Cost telemetry (core.ts) tells you what an agent *spent*; it can't tell a
 * cheap-but-wrong answer from a genuinely good one. `reportOutcome` lets the
 * caller mark a finished workflow as `success | failure | rework` so the
 * dashboard can divide spend by *successful* completions and surface
 * failure/rework rates.
 *
 * Deliberately a **standalone, stateless function** rather than something hung
 * off the wrapped client: the wrapped client/model must keep its framework-native
 * return type (a hard SDK rule), so there is no per-call handle to attach an
 * outcome to — and the outcome is judged *after* the response anyway. Taking
 * `agentId` + `accKey` again keeps it adapter-agnostic.
 *
 * Privacy: only the enum and an optional caller-supplied `workflow` **label**
 * ever leave the process — never prompt/response content. Like the rest of the
 * SDK it **fails open**: any transport error is swallowed so reporting an outcome
 * can never throw into the caller's path.
 */
export type Outcome = "success" | "failure" | "rework";

export interface ReportOutcomeOptions {
  /** Same agent id passed to `withCostControl`. */
  agentId: string;
  /** Bearer token for the telemetry backend. */
  accKey: string;
  /** Telemetry events URL; the outcomes URL is derived from it. Defaults to the hosted endpoint. */
  endpoint?: string;
  /**
   * Optional workflow label this completion belongs to, for by-workflow rollups.
   * A short label only — never prompt/response content.
   */
  workflow?: string;
}

/** Derive the outcomes URL from the events endpoint (…/events → …/outcomes). */
export function outcomesUrlFrom(endpoint: string): string {
  if (/\/events\/?$/.test(endpoint)) return endpoint.replace(/\/events\/?$/, "/outcomes");
  return `${endpoint.replace(/\/$/, "")}/outcomes`;
}

/**
 * Report the outcome of a completed workflow. Fire-and-forget and fail-open:
 * resolves even if the POST fails, never throwing into the caller.
 */
export async function reportOutcome(outcome: Outcome, opts: ReportOutcomeOptions): Promise<void> {
  if (!opts?.agentId || !opts?.accKey) return; // nothing to attribute to; stay silent
  const url = outcomesUrlFrom(opts.endpoint ?? DEFAULT_ENDPOINT);
  const body = {
    outcomes: [
      {
        agent_id: opts.agentId,
        outcome,
        ...(opts.workflow ? { workflow: opts.workflow } : {}),
        timestamp: new Date().toISOString(),
      },
    ],
  };
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.accKey}` },
      body: JSON.stringify(body),
    });
  } catch {
    // fail open — outcome reporting must never break real work
  }
}

import { KILL_CACHE_MS } from "./consts.js";
import type { ResolvedOptions } from "./types.js";

/** Thrown by a monitored call when the agent has been killed from the dashboard. */
export class AgentKilledError extends Error {
  constructor(public readonly agentId: string) {
    super(`agent-cost-controller: agent "${agentId}" is killed — request blocked.`);
    this.name = "AgentKilledError";
  }
}

interface CacheEntry {
  killed: boolean;
  at: number;
}

/**
 * Checks whether an agent has been killed, by polling the status endpoint.
 * Results are cached briefly so we don't add a network round-trip to every call.
 * **Fails open**: any lookup failure is treated as "not killed" — a flaky network
 * must never block the caller's real work.
 */
export class KillSwitch {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly opts: ResolvedOptions) {}

  async isKilled(agentId: string): Promise<boolean> {
    const now = Date.now();
    const hit = this.cache.get(agentId);
    if (hit && now - hit.at < KILL_CACHE_MS) return hit.killed;

    try {
      const res = await fetch(statusUrl(this.opts.endpoint, agentId), {
        headers: { Authorization: `Bearer ${this.opts.helmKey}` },
      });
      if (!res.ok) return false; // fail open
      const body = (await res.json()) as { status?: string };
      const killed = body?.status === "killed";
      this.cache.set(agentId, { killed, at: now });
      return killed;
    } catch (err) {
      this.opts.onError(err instanceof Error ? err : new Error(String(err)));
      return false; // fail open
    }
  }
}

/** Derive the status URL from the events endpoint (…/events → …/agents/<id>/status). */
function statusUrl(endpoint: string, agentId: string): string {
  const id = encodeURIComponent(agentId);
  if (/\/events\/?$/.test(endpoint)) {
    return endpoint.replace(/\/events\/?$/, `/agents/${id}/status`);
  }
  return `${endpoint.replace(/\/$/, "")}/agents/${id}/status`;
}

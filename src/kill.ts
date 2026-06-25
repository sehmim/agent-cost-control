import { KILL_CACHE_MS } from "./consts.js";
import type { RemoteConfig, ResolvedOptions } from "./types.js";

/** Thrown by a monitored call when the agent has been killed from the dashboard. */
export class AgentKilledError extends Error {
  constructor(public readonly agentId: string) {
    super(`agent-cost-controller: agent "${agentId}" is killed — request blocked.`);
    this.name = "AgentKilledError";
  }
}

interface StatusEntry {
  killed: boolean;
  config?: RemoteConfig;
  at: number;
}

/**
 * Polls the status endpoint for both kill state and (optionally) pushed config.
 * One fetch serves both `isKilled()` and `getConfig()`, cached briefly so we add
 * at most one round-trip per `KILL_CACHE_MS`. **Fails open**: any lookup failure
 * is treated as "not killed, no config" — a flaky network never blocks real work.
 */
export class KillSwitch {
  private cache = new Map<string, StatusEntry>();

  constructor(private readonly opts: ResolvedOptions) {}

  private async getStatus(agentId: string): Promise<StatusEntry> {
    const now = Date.now();
    const hit = this.cache.get(agentId);
    if (hit && now - hit.at < KILL_CACHE_MS) return hit;

    try {
      const res = await fetch(statusUrl(this.opts.endpoint, agentId), {
        headers: { Authorization: `Bearer ${this.opts.accKey}` },
      });
      if (!res.ok) return { killed: false, at: now }; // fail open, don't cache
      const body = (await res.json()) as { status?: string; config?: RemoteConfig };
      const entry: StatusEntry = { killed: body?.status === "killed", config: body?.config, at: now };
      this.cache.set(agentId, entry);
      return entry;
    } catch (err) {
      this.opts.onError(err instanceof Error ? err : new Error(String(err)));
      return { killed: false, at: now }; // fail open
    }
  }

  async isKilled(agentId: string): Promise<boolean> {
    return (await this.getStatus(agentId)).killed;
  }

  /** Config the backend pushed for this agent (routing policy, etc.), if any. */
  async getConfig(agentId: string): Promise<RemoteConfig | undefined> {
    return (await this.getStatus(agentId)).config;
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

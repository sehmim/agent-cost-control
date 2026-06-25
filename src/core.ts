import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_ENDPOINT,
  DEFAULT_FLUSH_INTERVAL,
  SDK_VERSION,
} from "./consts.js";
import { calculateCost } from "./pricing.js";
import { fingerprintMessages, hashOutput } from "./fingerprint.js";
import { AgentKilledError, KillSwitch } from "./kill.js";
import { route, type RoutePolicy } from "./router.js";
import {
  cacheKey,
  cacheUrlFrom,
  createCacheStore,
  DEFAULT_NAMESPACE,
  DEFAULT_TTL_SECONDS,
  type CacheOptions,
  type CacheStore,
} from "./cache.js";
import { TelemetryQueue } from "./telemetry.js";
import type {
  AdvancedOptions,
  KillInfo,
  MonitorOptions,
  ResolvedOptions,
  TelemetryEvent,
} from "./types.js";

/**
 * A finished model call, normalized so every framework adapter (OpenAI, Vercel
 * AI SDK, LangChain, OpenAI Agents) feeds the **same** privacy-safe pipeline.
 * `messages`/`outputParts` are only ever passed to the one-way fingerprint and
 * output hash — they are never transmitted as raw content.
 */
export interface CallRecord {
  /** Model id, e.g. "gpt-4o". */
  model: string;
  /** Request messages/prompt — fingerprinted (count, sizes, one-way hash), never sent raw. */
  messages?: unknown;
  inputTokens: number;
  outputTokens: number;
  /** Names of tools the model called. Names only — never arguments. */
  toolNames?: string[];
  /** Output text + tool-arg fragments — hashed one-way, never sent raw. */
  outputParts?: string[];
  stream: boolean;
  /** `Date.now()` captured when the call started, for latency. */
  startedAt: number;
  /** Set when the router redirected this call to a different model. */
  routing?: RoutingMeta;
  /** True when this record represents a cache hit (no real LLM call was made). */
  cacheHit?: boolean;
}

/** Where a routed call went and why. `to` is the model actually called. */
export interface RoutingMeta {
  from: string;
  to: string;
  rule: string | null;
  fallback: boolean;
}

/** What an adapter hands `preCall` before it makes the real LLM call. */
export interface PreCallRequest {
  model: string;
  messages: unknown;
  /** Number of tools offered in the request (for routing). */
  toolCount?: number;
}

/** The pre-call decision: which model to call, or a cached response to replay. */
export interface PreCallResult {
  /** Model the adapter should actually call (possibly routed). */
  model: string;
  /** Set when routing changed the model. */
  routing?: RoutingMeta;
  /** True when `cachedResponse` is a hit and the LLM call should be skipped. */
  cacheHit: boolean;
  /** The verbatim provider response to replay on a hit. */
  cachedResponse?: unknown;
  /** On a miss, the key to store the fresh response under (via `storeCache`). */
  cacheKey?: string;
  /** How the cache key was built, for telemetry. */
  cacheKeyKind: string | null;
}

// Queues kept alive so we can flush them all once on process exit.
const liveQueues = new Set<TelemetryQueue>();
let exitHookInstalled = false;

/** Flush every live queue once when the process is about to exit. */
function keepAlive(queue: TelemetryQueue): void {
  liveQueues.add(queue);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("beforeExit", () => {
    for (const q of liveQueues) void q.flush();
  });
}

/** Validate required options and fill in every default. Throws if agentId/accKey are missing. */
export function resolveOptions(options: MonitorOptions): ResolvedOptions {
  if (!options?.agentId || !options?.accKey) {
    throw new Error("agent-cost-controller: requires both `agentId` and `accKey`.");
  }
  return {
    agentId: options.agentId,
    accKey: options.accKey,
    endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
    flushInterval: options.flushInterval ?? DEFAULT_FLUSH_INTERVAL,
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    killCheck: options.killCheck ?? true,
    onKilled: options.onKilled,
    onError: options.onError ?? (() => {}),
  };
}

/**
 * The framework-agnostic heart of the SDK: one telemetry queue + one kill switch,
 * plus the privacy-safe `record()` step. Every adapter builds a Sink and feeds it
 * normalized `CallRecord`s — the wire format (usage + content-free fingerprint +
 * tool names + one-way output hash) is identical no matter which framework called.
 */
export class Sink {
  readonly opts: ResolvedOptions;
  private readonly queue: TelemetryQueue;
  private readonly kill: KillSwitch;
  private readonly localRouter?: RoutePolicy | "auto";
  private readonly localCache?: CacheOptions;
  /** Built cache stores keyed by their config signature (so we build each once). */
  private readonly cacheStores = new Map<string, CacheStore | null>();
  private lastRoutingActive = false;
  private lastCacheActive = false;

  constructor(options: AdvancedOptions) {
    this.opts = resolveOptions(options);
    this.queue = new TelemetryQueue(this.opts);
    this.kill = new KillSwitch(this.opts);

    this.localRouter = options.router ? options.router : undefined;
    this.localCache = options.cache;

    keepAlive(this.queue);
  }

  /** True only when kill-checking is on and the backend reports this agent killed. */
  async isBlocked(): Promise<boolean> {
    return this.opts.killCheck && (await this.kill.isKilled(this.opts.agentId));
  }

  /**
   * Decide what a killed agent's call resolves to. With an `onKilled` handler the
   * caller stays in control — its return value becomes the response, so a killed
   * (sub)agent degrades gracefully instead of throwing into the host. Without one
   * we throw `AgentKilledError`. Either way the real model call is never made.
   */
  blocked(model: string): unknown {
    const info: KillInfo = { agentId: this.opts.agentId, model };
    if (this.opts.onKilled) return this.opts.onKilled(info);
    throw new AgentKilledError(this.opts.agentId);
  }

  /**
   * Run the pre-call pipeline: pick the model (routing) and check the response
   * cache. Both are fast — routing is a pure function and a cache lookup is one
   * keyed read — so this adds no meaningful latency. Everything fails open: a
   * cache or config error degrades to a normal call on the original model.
   */
  async preCall(req: PreCallRequest): Promise<PreCallResult> {
    let model = req.model;
    let routing: RoutingMeta | undefined;

    const policy = await this.effectiveRouter();
    this.lastRoutingActive = !!policy;
    if (policy) {
      const d = route(policy, {
        model: req.model,
        messages: req.messages,
        toolCount: req.toolCount ?? 0,
      });
      if (d.selectedModel !== d.originalModel) {
        model = d.selectedModel;
        routing = { from: d.originalModel, to: d.selectedModel, rule: d.ruleMatched, fallback: false };
      }
    }

    let cacheHit = false;
    let cachedResponse: unknown;
    let key: string | undefined;
    let kind: string | null = null;
    const { store, ns } = await this.effectiveCache();
    this.lastCacheActive = !!store;
    if (store) {
      const fp = fingerprintMessages(req.messages);
      if (fp) {
        key = cacheKey(ns, model, fp.hash);
        kind = "fingerprint+model";
        try {
          const v = await store.get(key);
          if (v !== undefined && v !== null) {
            cacheHit = true;
            cachedResponse = v;
          }
        } catch (err) {
          this.opts.onError(err instanceof Error ? err : new Error(String(err))); // fail open
        }
      }
    }

    return {
      model,
      routing,
      cacheHit,
      cachedResponse,
      cacheKey: cacheHit ? undefined : key,
      cacheKeyKind: kind,
    };
  }

  /** Store a fresh response for later replay. Fire-and-forget; never throws. */
  storeCache(key: string, value: unknown): void {
    void this.effectiveCache()
      .then(({ store, ttl }) => (store ? store.set(key, value, ttl) : undefined))
      .catch((err) => this.opts.onError(err instanceof Error ? err : new Error(String(err))));
  }

  /** Routing policy in effect: backend-pushed config wins over the local option. */
  private async effectiveRouter(): Promise<RoutePolicy | "auto" | undefined> {
    if (this.opts.killCheck) {
      try {
        const cfg = await this.kill.getConfig(this.opts.agentId);
        if (cfg?.routing) return cfg.routing;
      } catch {
        // fall through to the local router
      }
    }
    return this.localRouter;
  }

  /**
   * Cache backend in effect: a dashboard-pushed config wins over the local option.
   * Stores are built once per distinct config and reused. The "managed" provider
   * gets the accKey + derived /v1/cache URL so it can proxy through the backend.
   */
  private async effectiveCache(): Promise<{ store: CacheStore | null; ns: string; ttl: number }> {
    let spec = this.localCache;
    if (this.opts.killCheck) {
      try {
        const cfg = await this.kill.getConfig(this.opts.agentId);
        if (cfg?.cache) spec = cfg.cache; // pushed config wins
      } catch {
        // fall back to the local cache option
      }
    }
    if (!spec) return { store: null, ns: DEFAULT_NAMESPACE, ttl: DEFAULT_TTL_SECONDS };

    const ns = spec.namespace ?? DEFAULT_NAMESPACE;
    const ttl = spec.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const sig = JSON.stringify(spec);
    let store = this.cacheStores.get(sig);
    if (store === undefined) {
      store = createCacheStore(spec, {
        accKey: this.opts.accKey,
        cacheUrl: cacheUrlFrom(this.opts.endpoint),
      });
      this.cacheStores.set(sig, store);
    }
    return { store, ns, ttl };
  }

  /** Build a telemetry event from a finished call and queue it. Never sends raw content. */
  record(rec: CallRecord): void {
    const prompt = fingerprintMessages(rec.messages);
    const outputHash = hashOutput(rec.outputParts ?? []);
    const tools = rec.toolNames ?? [];
    const event: TelemetryEvent = {
      agent_id: this.opts.agentId,
      model: rec.model,
      input_tokens: rec.inputTokens,
      output_tokens: rec.outputTokens,
      cost_usd: calculateCost(rec.model, rec.inputTokens, rec.outputTokens, this.opts.onError),
      latency_ms: Date.now() - rec.startedAt,
      timestamp: new Date().toISOString(),
      sdk_version: SDK_VERSION,
      stream: rec.stream,
      ...(prompt ? { prompt } : {}),
      ...(tools.length ? { tool_calls: tools } : {}),
      ...(outputHash ? { output_hash: outputHash } : {}),
      ...(rec.routing ? { routing: rec.routing } : {}),
      ...(rec.cacheHit ? { cache: { hit: true } } : {}),
      ...(this.features().length ? { sdk_features: this.features() } : {}),
    };
    this.queue.push(event);
  }

  /** Advanced features active on this client (local option or pushed config). */
  private features(): string[] {
    const f: string[] = [];
    if (this.localRouter || this.lastRoutingActive) f.push("routing");
    if (this.localCache || this.lastCacheActive) f.push("cache");
    return f;
  }

  /** Flush buffered telemetry now. Mainly for tests and graceful shutdown. */
  flush(): Promise<void> {
    return this.queue.flush();
  }
}

/** Build a telemetry/kill Sink for a framework adapter. */
export function createSink(options: AdvancedOptions): Sink {
  return new Sink(options);
}

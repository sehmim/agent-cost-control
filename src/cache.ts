/**
 * Exact-match response cache. The key is built from the model + the *existing*
 * content-free prompt fingerprint hash — so a cache lookup is one hash compare,
 * never an embedding call, and adds no latency. A hit replays the previous
 * provider response verbatim and skips the LLM call entirely.
 *
 * BYODB: bring your own Redis/Upstash; defaults to an in-process memory store.
 * Every operation **fails open** — a cache outage degrades to a normal LLM call,
 * never an error in the caller's path.
 *
 * Privacy note: unlike telemetry, the cache stores the raw provider response.
 * That data lives only in *your* store (memory or your own Redis/Upstash) and is
 * never sent to the ACC telemetry endpoint.
 */
export interface CacheOptions {
  /** Master switch. Defaults to true when a `cache` object is supplied. */
  enabled?: boolean;
  /**
   * Where cached responses live:
   *  - "memory"  — this process only (default).
   *  - "upstash" — your own Upstash via REST (BYODB); needs `url` (+ `token`).
   *  - "redis"   — your own Redis via `ioredis` (BYODB); needs `url`.
   *  - "managed" — the hosted ACC cache (proxied through the telemetry backend,
   *                authed by your accKey; storage-capped). No creds needed — it's
   *                usually configured from the dashboard and pushed via /status.
   */
  provider?: "memory" | "upstash" | "redis" | "managed";
  /** Upstash REST URL or Redis connection string (BYODB). */
  url?: string;
  /** Upstash REST token. */
  token?: string;
  /** Key namespace. Default "acc:cache". */
  namespace?: string;
  /** Entry lifetime in seconds. Default 86400 (24h). */
  ttlSeconds?: number;
}

/** Extra context the SDK supplies for the "managed" provider (never user-set). */
export interface CacheContext {
  /** Bearer accKey used to auth the managed-cache proxy. */
  accKey?: string;
  /** Absolute URL of the managed-cache endpoint (…/v1/cache). */
  cacheUrl?: string;
}

/** Derive the managed-cache URL from the events endpoint (…/events → …/cache). */
export function cacheUrlFrom(endpoint: string): string {
  if (/\/events\/?$/.test(endpoint)) return endpoint.replace(/\/events\/?$/, "/cache");
  return `${endpoint.replace(/\/$/, "")}/cache`;
}

export interface CacheStore {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

export const DEFAULT_NAMESPACE = "acc:cache";
export const DEFAULT_TTL_SECONDS = 86_400;

/** `{namespace}:{model}:{fingerprintHash}` — same prompt + model collide. */
export function cacheKey(namespace: string, model: string, hash: string): string {
  return `${namespace}:${model}:${hash}`;
}

/** In-process Map with TTL. Lost on restart; fine for a single long-running agent. */
class MemoryStore implements CacheStore {
  private map = new Map<string, { value: unknown; exp: number }>();
  async get(key: string): Promise<unknown | undefined> {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.map.set(key, { value, exp: Date.now() + ttlSeconds * 1000 });
  }
}

/** Upstash Redis over its serverless-friendly HTTP REST API (native fetch). */
class UpstashStore implements CacheStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}
  async get(key: string): Promise<unknown | undefined> {
    const res = await fetch(`${this.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { result?: string | null };
    if (body?.result == null) return undefined;
    try {
      return JSON.parse(body.result);
    } catch {
      return undefined;
    }
  }
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const payload = encodeURIComponent(JSON.stringify(value));
    await fetch(`${this.url}/set/${encodeURIComponent(key)}/${payload}?EX=${ttlSeconds}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
    });
  }
}

/** ioredis for long-running processes. Lazy-imported so it stays an optional dep. */
class RedisStore implements CacheStore {
  private readonly clientPromise: Promise<{
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
  }>;
  constructor(connectionString: string) {
    // Non-literal specifier keeps tsc from requiring ioredis types at build time.
    const mod = "ioredis";
    this.clientPromise = import(mod).then((m) => new (m.default ?? m)(connectionString));
  }
  async get(key: string): Promise<unknown | undefined> {
    const client = await this.clientPromise;
    const raw = await client.get(key);
    if (raw == null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const client = await this.clientPromise;
    await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
  }
}

/**
 * The hosted ACC cache. The SDK never sees our storage credentials — it proxies
 * get/set through the telemetry backend's `/v1/cache`, authed by the same accKey
 * as everything else. The backend enforces the per-owner storage cap + TTL.
 */
class ManagedStore implements CacheStore {
  constructor(
    private readonly url: string,
    private readonly accKey: string,
  ) {}
  async get(key: string): Promise<unknown | undefined> {
    const res = await fetch(`${this.url}?key=${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${this.accKey}` },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { value?: unknown };
    return body?.value ?? undefined;
  }
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await fetch(this.url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.accKey}` },
      body: JSON.stringify({ key, value, ttl: ttlSeconds }),
    });
  }
}

/** Build a cache store from options, or null when caching is off/misconfigured. */
export function createCacheStore(opts: CacheOptions, ctx: CacheContext = {}): CacheStore | null {
  if (opts.enabled === false) return null;
  const provider = opts.provider ?? "memory";
  if (provider === "memory") return new MemoryStore();
  if (provider === "upstash") {
    if (!opts.url || !opts.token) return null;
    return new UpstashStore(opts.url, opts.token);
  }
  if (provider === "redis") {
    if (!opts.url) return null;
    return new RedisStore(opts.url);
  }
  if (provider === "managed") {
    if (!ctx.cacheUrl || !ctx.accKey) return null;
    return new ManagedStore(ctx.cacheUrl, ctx.accKey);
  }
  return null;
}

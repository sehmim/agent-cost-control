import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_ENDPOINT,
  DEFAULT_FLUSH_INTERVAL,
  SDK_VERSION,
} from "./consts.js";
import { calculateCost } from "./pricing.js";
import { fingerprintMessages, hashOutput } from "./fingerprint.js";
import { AgentKilledError, KillSwitch } from "./kill.js";
import { TelemetryQueue } from "./telemetry.js";
import type { KillInfo, MonitorOptions, ResolvedOptions, TelemetryEvent } from "./types.js";

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

  constructor(options: MonitorOptions) {
    this.opts = resolveOptions(options);
    this.queue = new TelemetryQueue(this.opts);
    this.kill = new KillSwitch(this.opts);
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
    };
    this.queue.push(event);
  }

  /** Flush buffered telemetry now. Mainly for tests and graceful shutdown. */
  flush(): Promise<void> {
    return this.queue.flush();
  }
}

/** Build a telemetry/kill Sink for a framework adapter. */
export function createSink(options: MonitorOptions): Sink {
  return new Sink(options);
}

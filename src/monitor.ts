import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_ENDPOINT,
  DEFAULT_FLUSH_INTERVAL,
  SDK_VERSION,
} from "./consts.js";
import { calculateCost } from "./pricing.js";
import { fingerprintMessages } from "./fingerprint.js";
import { AgentKilledError, KillSwitch } from "./kill.js";
import { TelemetryQueue } from "./telemetry.js";
import type {
  KillInfo,
  MonitorOptions,
  PromptFingerprint,
  ResolvedOptions,
  TelemetryEvent,
} from "./types.js";

// The only parts of an OpenAI response/chunk we read.
interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}
interface Chunk {
  usage?: Usage | null;
}

// Queues kept alive so we can flush them all once on process exit.
const liveQueues = new Set<TelemetryQueue>();
let exitHookInstalled = false;

/**
 * Wrap an OpenAI client so token usage and cost are recorded asynchronously.
 * The returned client behaves identically — same methods, same types, same
 * return values. Only `agentId` and `helmKey` are required.
 */
export function monitor<T extends object>(client: T, options: MonitorOptions): T {
  if (!options?.agentId || !options?.helmKey) {
    throw new Error("agenthelm: monitor() requires both `agentId` and `helmKey`.");
  }
  if (!isOpenAIClient(client)) {
    throw new Error(
      "agenthelm: unsupported client. monitor() currently supports the OpenAI client (one exposing chat.completions.create).",
    );
  }

  const opts: ResolvedOptions = {
    agentId: options.agentId,
    helmKey: options.helmKey,
    endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
    flushInterval: options.flushInterval ?? DEFAULT_FLUSH_INTERVAL,
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    killCheck: options.killCheck ?? true,
    onKilled: options.onKilled,
    onError: options.onError ?? (() => {}),
  };

  const queue = new TelemetryQueue(opts);
  const kill = new KillSwitch(opts);
  keepAlive(queue);

  return intercept(client, queue, opts, kill);
}

function isOpenAIClient(client: unknown): boolean {
  const c = client as { chat?: { completions?: { create?: unknown } } } | null;
  return typeof c?.chat?.completions?.create === "function";
}

/**
 * Returns a Proxy of the client that swaps in a traced `chat.completions.create`
 * and passes everything else straight through. We proxy three levels —
 * client → chat → completions — replacing only the `create` method.
 */
function intercept<T extends object>(
  client: T,
  queue: TelemetryQueue,
  opts: ResolvedOptions,
  kill: KillSwitch,
): T {
  return swap(client, "chat", (chat) =>
    swap(chat, "completions", (completions) =>
      swap(completions, "create", (create) => {
        const original = create.bind(completions);
        return (...args: unknown[]) => traceCreate(original, args, queue, opts, kill);
      }),
    ),
  );
}

/**
 * Proxy `obj` so that reading `key` returns `replace(originalValue)`, while
 * every other property passes through (methods stay bound to `obj`).
 */
function swap<T extends object>(obj: T, key: string, replace: (value: any) => unknown): T {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === key) return replace(value);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Wraps the real create(): first refuse the call if the agent is killed, then
 * run it and record usage — without changing what the caller gets back.
 */
function traceCreate(
  create: (...a: unknown[]) => unknown,
  args: unknown[],
  queue: TelemetryQueue,
  opts: ResolvedOptions,
  kill: KillSwitch,
) {
  const params = (args[0] ?? {}) as Record<string, unknown>;
  const ctx: TraceContext = {
    queue,
    opts,
    kill,
    model: String(params.model ?? "unknown"),
    prompt: fingerprintMessages(params.messages),
    start: Date.now(),
  };

  // Streaming: OpenAI only includes usage on the final chunk if asked.
  if (params.stream === true) {
    const streamOpts = params.stream_options as Record<string, unknown> | undefined;
    if (streamOpts?.include_usage !== true) {
      args = [
        { ...params, stream_options: { ...streamOpts, include_usage: true } },
        ...args.slice(1),
      ];
    }
    return startStream(create, args, ctx);
  }

  return runOnce(create, args, ctx);
}

/** True only when kill-checking is on and the backend reports this agent killed. */
async function isBlocked(ctx: TraceContext): Promise<boolean> {
  return ctx.opts.killCheck && (await ctx.kill.isKilled(ctx.opts.agentId));
}

/**
 * Decide what a killed agent's call resolves to. With an `onKilled` handler the
 * caller stays in control — its return value becomes the response, so a killed
 * (sub)agent degrades gracefully instead of throwing into the host. Without one
 * we throw `AgentKilledError` to halt the loop. Either way the real LLM call is
 * never made, and only this agent's client is affected.
 */
function blocked(ctx: TraceContext): unknown {
  const info: KillInfo = { agentId: ctx.opts.agentId, model: ctx.model };
  if (ctx.opts.onKilled) return ctx.opts.onKilled(info);
  throw new AgentKilledError(ctx.opts.agentId);
}

/** Non-streaming: usage is on the resolved response. */
async function runOnce(create: (...a: unknown[]) => unknown, args: unknown[], ctx: TraceContext) {
  if (await isBlocked(ctx)) return blocked(ctx);
  const res = await create(...args);
  const usage = (res as { usage?: Usage | null })?.usage;
  emit(ctx, false, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0);
  return res;
}

/**
 * Streaming: if the agent is killed, run `blocked()` (throws, or lets the handler
 * run) and hand back an empty stream so `for await` simply ends without spend.
 * Otherwise start the real call eagerly — so the request begins when the caller
 * awaits, just like the unwrapped client — and return a pass-through iterable.
 */
async function startStream(
  create: (...a: unknown[]) => unknown,
  args: unknown[],
  ctx: TraceContext,
): Promise<AsyncIterable<Chunk>> {
  if (await isBlocked(ctx)) {
    blocked(ctx); // throws when there's no onKilled handler
    return emptyStream();
  }
  const stream = (await create(...args)) as AsyncIterable<Chunk>;
  return passthrough(stream, ctx);
}

/** A stream that yields nothing — used when a killed agent opens a stream. */
async function* emptyStream(): AsyncGenerator<Chunk> {
  // intentionally empty: no call made, no chunks to yield.
}

/** Re-yield every chunk untouched; capture usage off whichever chunk carries it. */
async function* passthrough(stream: AsyncIterable<Chunk>, ctx: TraceContext) {
  let input = 0;
  let output = 0;
  try {
    for await (const chunk of stream) {
      if (chunk?.usage) {
        input = chunk.usage.prompt_tokens ?? input;
        output = chunk.usage.completion_tokens ?? output;
      }
      yield chunk;
    }
  } finally {
    emit(ctx, true, input, output);
  }
}

interface TraceContext {
  queue: TelemetryQueue;
  opts: ResolvedOptions;
  kill: KillSwitch;
  model: string;
  prompt: PromptFingerprint | undefined;
  start: number;
}

/** Build a telemetry event from a finished call and queue it. */
function emit(ctx: TraceContext, stream: boolean, input: number, output: number): void {
  const event: TelemetryEvent = {
    agent_id: ctx.opts.agentId,
    model: ctx.model,
    input_tokens: input,
    output_tokens: output,
    cost_usd: calculateCost(ctx.model, input, output, ctx.opts.onError),
    latency_ms: Date.now() - ctx.start,
    timestamp: new Date().toISOString(),
    sdk_version: SDK_VERSION,
    stream,
    ...(ctx.prompt ? { prompt: ctx.prompt } : {}),
  };
  ctx.queue.push(event);
}

/** Flush every live queue once when the process is about to exit. */
function keepAlive(queue: TelemetryQueue): void {
  liveQueues.add(queue);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("beforeExit", () => {
    for (const q of liveQueues) void q.flush();
  });
}

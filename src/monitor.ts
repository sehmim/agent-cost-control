import { createSink, Sink } from "./core.js";
import type { MonitorOptions } from "./types.js";

// The only parts of an OpenAI response/chunk we read.
interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}
/** A tool call: name is reported; arguments are only ever fed into a one-way hash. */
interface ToolCall {
  function?: { name?: string; arguments?: string } | null;
}
interface OutputPart {
  content?: string | null;
  tool_calls?: ToolCall[] | null;
}
interface Choice {
  message?: OutputPart | null;
  delta?: OutputPart | null;
}
interface Response {
  usage?: Usage | null;
  choices?: Choice[] | null;
}
interface Chunk {
  usage?: Usage | null;
  choices?: Choice[] | null;
}

/** Pull the names of tools the model asked to call. Names only — never arguments. */
function toolNames(choices: Choice[] | null | undefined, pick: (c: Choice) => ToolCall[] | null | undefined): string[] {
  const names: string[] = [];
  for (const choice of choices ?? []) {
    for (const call of pick(choice) ?? []) {
      const name = call?.function?.name;
      if (name) names.push(name);
    }
  }
  return names;
}

/** Output text + tool-call JSON to feed the output hash. Used to hash, never transmitted raw. */
function outputParts(choices: Choice[] | null | undefined, pick: (c: Choice) => OutputPart | null | undefined): string[] {
  const parts: string[] = [];
  for (const choice of choices ?? []) {
    const out = pick(choice);
    if (typeof out?.content === "string") parts.push(out.content);
    for (const call of out?.tool_calls ?? []) {
      const args = call?.function?.arguments;
      if (typeof args === "string") parts.push(args);
    }
  }
  return parts;
}

/**
 * Wrap an OpenAI client so token usage and cost are recorded asynchronously.
 * The returned client behaves identically — same methods, same types, same
 * return values. Only `agentId` and `accKey` are required.
 */
export function withCostControl<T extends object>(client: T, options: MonitorOptions): T {
  if (!options?.agentId || !options?.accKey) {
    throw new Error("agent-cost-controller: withCostControl() requires both `agentId` and `accKey`.");
  }
  if (!isOpenAIClient(client)) {
    throw new Error(
      "agent-cost-controller: unsupported client. withCostControl() supports the OpenAI client (one exposing chat.completions.create). For other frameworks import the matching adapter: agent-cost-controller/ai, /langchain, or /agents.",
    );
  }

  const sink = createSink(options);
  return intercept(client, sink);
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
function intercept<T extends object>(client: T, sink: Sink): T {
  return swap(client, "chat", (chat) =>
    swap(chat, "completions", (completions) =>
      swap(completions, "create", (create) => {
        const original = create.bind(completions);
        return (...args: unknown[]) => traceCreate(original, args, sink);
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

interface TraceContext {
  sink: Sink;
  model: string;
  messages: unknown;
  start: number;
}

/**
 * Wraps the real create(): first refuse the call if the agent is killed, then
 * run it and record usage — without changing what the caller gets back.
 */
function traceCreate(create: (...a: unknown[]) => unknown, args: unknown[], sink: Sink) {
  const params = (args[0] ?? {}) as Record<string, unknown>;
  const ctx: TraceContext = {
    sink,
    model: String(params.model ?? "unknown"),
    messages: params.messages,
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

/** Non-streaming: usage, tool calls, and output are on the resolved response. */
async function runOnce(create: (...a: unknown[]) => unknown, args: unknown[], ctx: TraceContext) {
  if (await ctx.sink.isBlocked()) return ctx.sink.blocked(ctx.model);
  const res = (await create(...args)) as Response;
  const tools = toolNames(res?.choices, (c) => c.message?.tool_calls);
  const out = outputParts(res?.choices, (c) => c.message);
  ctx.sink.record({
    model: ctx.model,
    messages: ctx.messages,
    inputTokens: res?.usage?.prompt_tokens ?? 0,
    outputTokens: res?.usage?.completion_tokens ?? 0,
    toolNames: tools,
    outputParts: out,
    stream: false,
    startedAt: ctx.start,
  });
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
  if (await ctx.sink.isBlocked()) {
    ctx.sink.blocked(ctx.model); // throws when there's no onKilled handler
    return emptyStream();
  }
  const stream = (await create(...args)) as AsyncIterable<Chunk>;
  return passthrough(stream, ctx);
}

/** A stream that yields nothing — used when a killed agent opens a stream. */
async function* emptyStream(): AsyncGenerator<Chunk> {
  // intentionally empty: no call made, no chunks to yield.
}

/** Re-yield every chunk untouched; capture usage, tool names, and output as they stream by. */
async function* passthrough(stream: AsyncIterable<Chunk>, ctx: TraceContext) {
  let input = 0;
  let output = 0;
  const tools: string[] = [];
  const out: string[] = [];
  try {
    for await (const chunk of stream) {
      if (chunk?.usage) {
        input = chunk.usage.prompt_tokens ?? input;
        output = chunk.usage.completion_tokens ?? output;
      }
      // Tool-call names arrive on the opening delta of each call.
      tools.push(...toolNames(chunk?.choices, (c) => c.delta?.tool_calls));
      // Output text + tool-arg fragments accumulate across deltas (hashed at the end).
      out.push(...outputParts(chunk?.choices, (c) => c.delta));
      yield chunk;
    }
  } finally {
    ctx.sink.record({
      model: ctx.model,
      messages: ctx.messages,
      inputTokens: input,
      outputTokens: output,
      toolNames: tools,
      outputParts: out,
      stream: true,
      startedAt: ctx.start,
    });
  }
}

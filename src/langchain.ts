import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import { createSink, type Sink } from "./core.js";
import { AgentKilledError } from "./kill.js";
import type { MonitorOptions } from "./types.js";

/**
 * LangChain.js / LangGraph.js adapter.
 *
 * LangChain's idiomatic observability hook is a callback handler — but callbacks
 * can only *observe*, never block. So this ships two pieces:
 *
 *  - `CostControlHandler` — a `BaseCallbackHandler` that records token usage,
 *    tool names, and a content-free fingerprint after each LLM/chat-model run.
 *  - `wrapModel(model, options)` — wraps a chat model so the kill switch is
 *    *enforced* (a killed agent's `invoke`/`stream`/`batch` is refused before the
 *    call) and the handler is attached automatically. Works inside LangGraph
 *    nodes, since each node calls the wrapped model.
 *
 * Privacy is unchanged: only usage, a content-free fingerprint, tool **names**,
 * and a one-way output hash leave the process — never raw prompts/completions/keys.
 */

interface StartInfo {
  startedAt: number;
  messages: { role: string; content: unknown }[];
  model: string;
}

interface UsageMeta {
  input_tokens?: number;
  output_tokens?: number;
}
interface ToolCallLite {
  name?: string;
  args?: unknown;
}

/** Best-effort model id from the start callback's serialized model + invocation params. */
function modelId(llm: Serialized, extraParams?: Record<string, unknown>): string {
  const invocation = extraParams?.invocation_params as { model?: string; model_name?: string } | undefined;
  const fromParams = invocation?.model ?? invocation?.model_name;
  if (typeof fromParams === "string" && fromParams) return fromParams;
  const id = (llm as { id?: string[] })?.id;
  if (Array.isArray(id) && id.length) return String(id[id.length - 1]);
  return "unknown";
}

/** A telemetry-only callback handler. Add it to any LangChain model/chain/graph run. */
export class CostControlHandler extends BaseCallbackHandler {
  name = "agent_cost_controller";
  private readonly sink: Sink;
  private readonly runs = new Map<string, StartInfo>();

  constructor(options: MonitorOptions) {
    super();
    this.sink = createSink(options);
  }

  handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): void {
    const flat = messages.flat().map((m) => ({
      role: messageRole(m),
      content: (m as { content?: unknown })?.content,
    }));
    this.runs.set(runId, { startedAt: Date.now(), messages: flat, model: modelId(llm, extraParams) });
  }

  handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): void {
    const messages = prompts.map((p) => ({ role: "user", content: p }));
    this.runs.set(runId, { startedAt: Date.now(), messages, model: modelId(llm, extraParams) });
  }

  handleLLMEnd(output: LLMResult, runId: string): void {
    const start = this.runs.get(runId);
    this.runs.delete(runId);

    const { input, output: outTokens, tools, outParts } = readResult(output);
    const usage = (output.llmOutput?.tokenUsage ?? {}) as { promptTokens?: number; completionTokens?: number };

    this.sink.record({
      model: start?.model ?? "unknown",
      messages: start?.messages,
      inputTokens: usage.promptTokens ?? input,
      outputTokens: usage.completionTokens ?? outTokens,
      toolNames: tools,
      outputParts: outParts,
      stream: false,
      startedAt: start?.startedAt ?? Date.now(),
    });
  }

  handleLLMError(_err: unknown, runId: string): void {
    this.runs.delete(runId); // drop the pending start; nothing to record
  }

  /** Internal: the sink, so `wrapModel` can share one handler instance + kill gate. */
  get _sink(): Sink {
    return this.sink;
  }
}

/**
 * Wrap a chat model so the kill switch is enforced and telemetry is recorded.
 * Refuses `invoke`/`stream`/`batch` for a killed agent (throws `AgentKilledError`,
 * or runs `onKilled`), and injects the `CostControlHandler` into each call.
 *
 * ```ts
 * import { wrapModel } from "agent-cost-controller/langchain";
 * const model = wrapModel(new ChatOpenAI({ model: "gpt-4o" }), { agentId: "bot", accKey: "acc_..." });
 * ```
 */
export function wrapModel<M extends object>(model: M, options: MonitorOptions): M {
  const handler = new CostControlHandler(options);
  return gate(model, handler._sink, handler);
}

// Methods that return a NEW runnable bound to the model (tools, config, …). We
// re-wrap their result with the SAME sink + handler so the kill gate and telemetry
// survive the idiomatic `model.bindTools(tools).invoke(...)` path (and LangGraph).
const REWRAP = new Set(["bindTools", "bind", "withConfig", "withRetry", "withListeners", "withStructuredOutput"]);
// Methods that actually run the model — gated on the kill switch, handler injected.
const GATED = new Set(["invoke", "stream", "batch"]);

function gate<M extends object>(model: M, sink: Sink, handler: CostControlHandler): M {
  return new Proxy(model, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function") {
        return typeof value === "function" ? (value as Function).bind(target) : value;
      }
      if (GATED.has(prop)) {
        const original = value.bind(target);
        return async (input: unknown, config?: Record<string, unknown>) => {
          if (await sink.isBlocked()) return sink.blocked(modelName(target)); // throws without onKilled
          return original(input, withHandler(config, handler));
        };
      }
      if (REWRAP.has(prop)) {
        return (...args: unknown[]) => gate(value.apply(target, args) as object, sink, handler);
      }
      return value.bind(target);
    },
  });
}

/** Merge our handler into a call config's `callbacks` without dropping the caller's. */
function withHandler(
  config: Record<string, unknown> | undefined,
  handler: CostControlHandler,
): Record<string, unknown> {
  const existing = config?.callbacks;
  if (Array.isArray(existing)) return { ...config, callbacks: [...existing, handler] };
  if (existing) return { ...config, callbacks: [existing, handler] };
  return { ...config, callbacks: [handler] };
}

/** LangChain message role: `_getType()` ("human"/"ai"/"system"/"tool") or a `role` field. */
function messageRole(m: BaseMessage): string {
  const typed = m as { _getType?: () => string; getType?: () => string; role?: string };
  if (typeof typed._getType === "function") return typed._getType();
  if (typeof typed.getType === "function") return typed.getType();
  return typed.role ?? "unknown";
}

function modelName(model: object): string {
  const m = model as { model?: string; modelName?: string };
  return m.model ?? m.modelName ?? "unknown";
}

/** Sum usage + collect tool names / hashable output across an LLMResult's generations. */
function readResult(output: LLMResult): {
  input: number;
  output: number;
  tools: string[];
  outParts: string[];
} {
  let input = 0;
  let outTokens = 0;
  const tools: string[] = [];
  const outParts: string[] = [];

  for (const row of output.generations ?? []) {
    for (const gen of row ?? []) {
      if (typeof gen.text === "string" && gen.text) outParts.push(gen.text);
      const message = (gen as { message?: Record<string, unknown> }).message;
      if (message) {
        const meta = message.usage_metadata as UsageMeta | undefined;
        input += meta?.input_tokens ?? 0;
        outTokens += meta?.output_tokens ?? 0;
        for (const call of (message.tool_calls as ToolCallLite[] | undefined) ?? []) {
          if (call?.name) tools.push(call.name);
          if (call?.args != null) outParts.push(JSON.stringify(call.args));
        }
      }
    }
  }
  return { input, output: outTokens, tools, outParts };
}

export { AgentKilledError };

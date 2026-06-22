import type { Model, ModelRequest, ModelResponse, StreamEvent } from "@openai/agents";
import { createSink, type Sink } from "./core.js";
import { AgentKilledError } from "./kill.js";
import type { MonitorOptions } from "./types.js";

/**
 * OpenAI Agents SDK (TS) adapter.
 *
 * The Agents SDK runs every LLM call through a `Model` (`getResponse` /
 * `getStreamedResponse`). Wrapping the model gives both kill-enforcement and
 * telemetry in one place — consistent with the other adapters. Hand the wrapped
 * model to an `Agent`:
 *
 * ```ts
 * import { wrapAgentsModel } from "agent-cost-controller/agents";
 * import { Agent, run, OpenAIResponsesModel } from "@openai/agents";
 * const model = wrapAgentsModel(new OpenAIResponsesModel(client, "gpt-4o"), { agentId: "bot", accKey: "acc_..." });
 * const agent = new Agent({ name: "Support", model });
 * ```
 *
 * Privacy is unchanged: only usage, a content-free fingerprint, tool **names**,
 * and a one-way output hash leave the process — never raw prompts/completions/keys.
 */

interface AnyUsage {
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}
interface OutputItem {
  type?: string;
  text?: string;
  name?: string;
  arguments?: string;
  content?: { type?: string; text?: string }[];
}

const inTokens = (u: AnyUsage | undefined): number => u?.inputTokens ?? u?.promptTokens ?? 0;
const outTokens = (u: AnyUsage | undefined): number => u?.outputTokens ?? u?.completionTokens ?? 0;

/** Collect tool names + hashable output fragments from a response's output items. */
function readOutput(items: OutputItem[] | undefined): { tools: string[]; out: string[] } {
  const tools: string[] = [];
  const out: string[] = [];
  for (const item of items ?? []) {
    if (item?.type === "function_call") {
      if (item.name) tools.push(item.name);
      if (typeof item.arguments === "string") out.push(item.arguments);
    }
    if (item?.type === "output_text" && typeof item.text === "string") out.push(item.text);
    for (const part of item?.content ?? []) {
      if (part?.type === "output_text" && typeof part.text === "string") out.push(part.text);
    }
  }
  return { tools, out };
}

/** Turn an Agents request into a fingerprint-able message list (no raw content is sent). */
function requestMessages(request: ModelRequest): { role: string; content: unknown }[] {
  const messages: { role: string; content: unknown }[] = [];
  const sys = (request as { systemInstructions?: string }).systemInstructions;
  if (sys) messages.push({ role: "system", content: sys });
  const input = (request as { input?: unknown }).input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input as { role?: string; content?: unknown }[]) {
      messages.push({ role: item?.role ?? "user", content: item?.content ?? item });
    }
  }
  return messages;
}

function modelId(model: Model): string {
  const m = model as { _model?: string; model?: string };
  return m._model ?? m.model ?? "unknown";
}

/**
 * Wrap an Agents SDK `Model` so it reports cost/usage and honors the kill switch.
 * A killed agent's `getResponse`/`getStreamedResponse` is refused before any
 * spend (throws `AgentKilledError`, or returns/streams an `onKilled` fallback).
 */
export function wrapAgentsModel<M extends Model>(model: M, options: MonitorOptions): M {
  const sink = createSink(options);
  const id = modelId(model);

  return new Proxy(model, {
    get(target, prop, receiver) {
      if (prop === "getResponse") {
        return (request: ModelRequest) => getResponse(target, request, sink, id);
      }
      if (prop === "getStreamedResponse") {
        return (request: ModelRequest) => getStreamedResponse(target, request, sink, id);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function getResponse(
  model: Model,
  request: ModelRequest,
  sink: Sink,
  id: string,
): Promise<ModelResponse> {
  const start = Date.now();
  if (await sink.isBlocked()) return blockedResponse(sink, id);

  const result = await model.getResponse(request);
  const r = result as unknown as { usage?: AnyUsage; output?: OutputItem[] };
  const { tools, out } = readOutput(r.output);
  sink.record({
    model: id,
    messages: requestMessages(request),
    inputTokens: inTokens(r.usage),
    outputTokens: outTokens(r.usage),
    toolNames: tools,
    outputParts: out,
    stream: false,
    startedAt: start,
  });
  return result;
}

async function* getStreamedResponse(
  model: Model,
  request: ModelRequest,
  sink: Sink,
  id: string,
): AsyncGenerator<StreamEvent> {
  const start = Date.now();
  if (await sink.isBlocked()) {
    sink.blocked(id); // throws when there's no onKilled handler
    return; // empty stream — no spend
  }

  let input = 0;
  let output = 0;
  let tools: string[] = [];
  const out: string[] = [];
  try {
    for await (const event of model.getStreamedResponse(request)) {
      const e = event as { type?: string; delta?: string; response?: { usage?: AnyUsage; output?: OutputItem[] } };
      if (e?.type === "output_text_delta" && typeof e.delta === "string") out.push(e.delta);
      if (e?.type === "response_done" && e.response) {
        input = inTokens(e.response.usage);
        output = outTokens(e.response.usage);
        const read = readOutput(e.response.output);
        tools = read.tools;
        out.push(...read.out);
      }
      yield event;
    }
  } finally {
    sink.record({
      model: id,
      messages: requestMessages(request),
      inputTokens: input,
      outputTokens: output,
      toolNames: tools,
      outputParts: out,
      stream: true,
      startedAt: start,
    });
  }
}

/** A killed agent's non-streaming response: an `onKilled` fallback as text, or throw. */
function blockedResponse(sink: Sink, id: string): ModelResponse {
  const fallback = sink.blocked(id); // throws when no onKilled handler
  return {
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: typeof fallback === "string" ? fallback : "" }],
      },
    ],
  } as unknown as ModelResponse;
}

export { AgentKilledError };

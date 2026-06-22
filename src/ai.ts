import { wrapLanguageModel } from "ai";
import type { LanguageModelMiddleware } from "ai";
import { createSink, type Sink } from "./core.js";
import type { MonitorOptions } from "./types.js";

/** The concrete model type `wrapLanguageModel` accepts (LanguageModelV3), without importing the name. */
type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];

/**
 * Vercel AI SDK + Mastra adapter.
 *
 * The official extension point for the Vercel AI SDK is `LanguageModelMiddleware`
 * (the v2 middleware). Because **Mastra is built on the Vercel AI SDK** and takes
 * a model you hand it, the same wrapper covers both — pass `withCostControl(model)`
 * either to `generateText`/`streamText` or to a Mastra `Agent({ model })`.
 *
 * Privacy is unchanged: only token usage, a content-free prompt fingerprint, tool
 * **names**, and a one-way output hash leave the process — never raw prompts,
 * completions, or keys. Telemetry is recorded after the call, never adding latency.
 */

// We read these fields structurally (by `.type`) so the adapter tolerates minor
// shape changes across AI SDK versions. Usage field names differ between major
// versions; we accept both.
// A token count is either a plain number (AI SDK v2) or a detail object
// (`{ total, noCache, … }` in v3 / the OpenAI Responses model). Accept both.
type TokenCount = number | { total?: number } | undefined;
interface AnyUsage {
  inputTokens?: TokenCount;
  outputTokens?: TokenCount;
  promptTokens?: TokenCount;
  completionTokens?: TokenCount;
}
interface AnyContentPart {
  type?: string;
  text?: string;
  toolName?: string;
  input?: string;
  args?: unknown;
  delta?: string;
  usage?: AnyUsage;
}

/** Coerce a token count (number or `{ total }`) to a number; undefined → not present. */
function tokenNum(v: TokenCount): number | undefined {
  if (typeof v === "number") return v;
  if (v && typeof v.total === "number") return v.total;
  return undefined;
}
const inTokens = (u: AnyUsage | undefined): number =>
  tokenNum(u?.inputTokens) ?? tokenNum(u?.promptTokens) ?? 0;
const outTokens = (u: AnyUsage | undefined): number =>
  tokenNum(u?.outputTokens) ?? tokenNum(u?.completionTokens) ?? 0;

/** Pull tool names + hashable output fragments out of a finished generate result's content. */
function readContent(content: AnyContentPart[] | undefined): { tools: string[]; out: string[] } {
  const tools: string[] = [];
  const out: string[] = [];
  for (const part of content ?? []) {
    if (part?.type === "text" && typeof part.text === "string") out.push(part.text);
    if (part?.type === "tool-call") {
      if (part.toolName) tools.push(part.toolName);
      if (typeof part.input === "string") out.push(part.input);
      else if (part.args != null) out.push(JSON.stringify(part.args));
    }
  }
  return { tools, out };
}

/** Build the LanguageModelMiddleware that records every generate/stream call. */
export function costControlMiddleware(options: MonitorOptions): LanguageModelMiddleware {
  const sink = createSink(options);

  return {
    specificationVersion: "v3",

    async wrapGenerate({ doGenerate, params, model }) {
      const start = Date.now();
      const modelId = model?.modelId ?? "unknown";
      if (await sink.isBlocked()) return blockedGenerate(sink, modelId);

      const result = await doGenerate();
      const r = result as unknown as { content?: AnyContentPart[]; usage?: AnyUsage };
      const { tools, out } = readContent(r.content);
      sink.record({
        model: modelId,
        messages: (params as { prompt?: unknown })?.prompt,
        inputTokens: inTokens(r.usage),
        outputTokens: outTokens(r.usage),
        toolNames: tools,
        outputParts: out,
        stream: false,
        startedAt: start,
      });
      return result;
    },

    async wrapStream({ doStream, params, model }) {
      const start = Date.now();
      const modelId = model?.modelId ?? "unknown";
      if (await sink.isBlocked()) return blockedStream(sink, modelId);

      const result = await doStream();
      const messages = (params as { prompt?: unknown })?.prompt;
      const tapped = (result.stream as ReadableStream<AnyContentPart>).pipeThrough(
        tap(sink, modelId, messages, start),
      );
      return { ...result, stream: tapped as typeof result.stream };
    },
  };
}

/**
 * Convenience: wrap a model so it reports cost/usage and honors the kill switch.
 * Hand the returned model to `generateText`/`streamText` or a Mastra `Agent`.
 *
 * ```ts
 * import { withCostControl } from "agent-cost-controller/ai";
 * import { openai } from "@ai-sdk/openai";
 * const model = withCostControl(openai("gpt-4o"), { agentId: "support-bot", accKey: "acc_..." });
 * await generateText({ model, prompt: "…" });
 * ```
 */
export function withCostControl(model: WrappableModel, options: MonitorOptions): WrappableModel {
  return wrapLanguageModel({ model, middleware: costControlMiddleware(options) });
}

/** A TransformStream that re-emits every part untouched and records usage on flush. */
function tap(
  sink: Sink,
  model: string,
  messages: unknown,
  start: number,
): TransformStream<AnyContentPart, AnyContentPart> {
  let input = 0;
  let output = 0;
  const tools: string[] = [];
  const out: string[] = [];
  return new TransformStream({
    transform(part, controller) {
      switch (part?.type) {
        case "text-delta":
          if (typeof part.delta === "string") out.push(part.delta);
          break;
        case "tool-input-start":
          if (part.toolName) tools.push(part.toolName);
          break;
        case "tool-input-delta":
          if (typeof part.delta === "string") out.push(part.delta);
          break;
        case "tool-call":
          if (part.toolName) tools.push(part.toolName);
          if (typeof part.input === "string") out.push(part.input);
          break;
        case "finish":
          input = inTokens(part.usage);
          output = outTokens(part.usage);
          break;
      }
      controller.enqueue(part);
    },
    flush() {
      sink.record({
        model,
        messages,
        inputTokens: input,
        outputTokens: output,
        toolNames: tools,
        outputParts: out,
        stream: true,
        startedAt: start,
      });
    },
  });
}

/**
 * A killed agent's generate call. `sink.blocked()` throws `AgentKilledError`
 * unless an `onKilled` handler is set, in which case its (stringified) return
 * value becomes a minimal valid text result so the host degrades gracefully.
 */
function blockedGenerate(sink: Sink, model: string): any {
  const fallback = sink.blocked(model); // throws when no onKilled handler
  return {
    content: [{ type: "text", text: stringify(fallback) }],
    finishReason: "stop",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    warnings: [],
  };
}

/** A killed agent's stream: emit a single finish part (no spend) then end. */
function blockedStream(sink: Sink, model: string): any {
  sink.blocked(model); // throws when no onKilled handler
  const stream = new ReadableStream<AnyContentPart>({
    start(controller) {
      controller.enqueue({
        type: "finish",
        usage: { inputTokens: 0, outputTokens: 0 },
      } as AnyContentPart);
      controller.close();
    },
  });
  return { stream };
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

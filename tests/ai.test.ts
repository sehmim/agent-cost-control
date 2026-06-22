import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { costControlMiddleware } from "../src/ai.js";
import { AgentKilledError } from "../src/index.js";

const base = { agentId: "a1", accKey: "acc_test", endpoint: "https://x.test/v1/events", batchSize: 1, killCheck: false };
const model = { modelId: "gpt-4o" };
const params = { prompt: [{ role: "user", content: [{ type: "text", text: "SECRET_PROMPT" }] }] };

/** Route status checks vs telemetry posts to canned responses. */
function stubFetch(status: "active" | "killed") {
  return vi.fn(async (url: string) => {
    if (String(url).includes("/status")) return new Response(JSON.stringify({ status }), { status: 200 });
    return new Response(null, { status: 200 });
  });
}

function streamOf(parts: unknown[]): ReadableStream {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

describe("vercel ai sdk middleware", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("records a generate call, returns the result unchanged, no raw content", async () => {
    const mw = costControlMiddleware(base);
    const result = {
      content: [
        { type: "text", text: "SECRET_OUTPUT" },
        { type: "tool-call", toolName: "get_weather", input: '{"city":"Tokyo"}' },
      ],
      usage: { inputTokens: 100, outputTokens: 50 },
      finishReason: "stop",
      warnings: [],
    };
    const out = await (mw.wrapGenerate as any)({ doGenerate: async () => result, params, model });
    expect(out).toBe(result);

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.events[0]).toMatchObject({
      model: "gpt-4o",
      input_tokens: 100,
      output_tokens: 50,
      stream: false,
      tool_calls: ["get_weather"],
    });
    expect(body.events[0].prompt.message_count).toBe(1);
    const wire = JSON.stringify(body.events[0]);
    expect(wire).not.toContain("SECRET_PROMPT");
    expect(wire).not.toContain("SECRET_OUTPUT");
    expect(wire).not.toContain("Tokyo");
  });

  it("coerces AI SDK v3 object usage ({total}) to numeric tokens", async () => {
    const mw = costControlMiddleware(base);
    const result = {
      content: [{ type: "text", text: "hi" }],
      // v3 / OpenAI Responses model: token counts are detail objects, not numbers.
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0 },
        outputTokens: { total: 50, text: 50, reasoning: 0 },
      },
      finishReason: "stop",
      warnings: [],
    };
    await (mw.wrapGenerate as any)({ doGenerate: async () => result, params, model });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const event = JSON.parse((fetch as any).mock.calls[0][1].body).events[0];
    expect(event.input_tokens).toBe(100);
    expect(event.output_tokens).toBe(50);
    expect(event.cost_usd).toBeGreaterThan(0);
  });

  it("taps a stream, re-emits every part, records usage from finish", async () => {
    const mw = costControlMiddleware(base);
    const parts = [
      { type: "text-delta", delta: "SECRET_OUTPUT" },
      { type: "tool-input-start", toolName: "get_weather" },
      { type: "finish", usage: { inputTokens: 7, outputTokens: 3 } },
    ];
    const { stream } = await (mw.wrapStream as any)({ doStream: async () => ({ stream: streamOf(parts) }), params, model });

    const seen: any[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push(value);
    }
    expect(seen).toHaveLength(3); // passthrough untouched

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.events[0]).toMatchObject({ model: "gpt-4o", input_tokens: 7, output_tokens: 3, stream: true, tool_calls: ["get_weather"] });
    expect(JSON.stringify(body.events[0])).not.toContain("SECRET_OUTPUT");
  });

  it("throws AgentKilledError for a killed agent before any model call", async () => {
    vi.stubGlobal("fetch", stubFetch("killed"));
    const mw = costControlMiddleware({ ...base, killCheck: true });
    const doGenerate = vi.fn();
    await expect((mw.wrapGenerate as any)({ doGenerate, params, model })).rejects.toBeInstanceOf(AgentKilledError);
    expect(doGenerate).not.toHaveBeenCalled();
  });

  it("onKilled yields a synthesized text result instead of throwing", async () => {
    vi.stubGlobal("fetch", stubFetch("killed"));
    const mw = costControlMiddleware({ ...base, killCheck: true, onKilled: () => "stopped" });
    const doGenerate = vi.fn();
    const out: any = await (mw.wrapGenerate as any)({ doGenerate, params, model });
    expect(doGenerate).not.toHaveBeenCalled();
    expect(out.content[0]).toEqual({ type: "text", text: "stopped" });
    expect(out.finishReason).toBe("stop");
  });
});

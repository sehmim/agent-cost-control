import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapAgentsModel } from "../src/agents.js";
import { AgentKilledError } from "../src/index.js";

const base = { agentId: "a1", accKey: "acc_test", endpoint: "https://x.test/v1/events", batchSize: 1, killCheck: false };

function stubFetch(status: "active" | "killed") {
  return vi.fn(async (url: string) => {
    if (String(url).includes("/status")) return new Response(JSON.stringify({ status }), { status: 200 });
    return new Response(null, { status: 200 });
  });
}

describe("openai agents sdk model wrapper", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("records a getResponse call, returns it unchanged, no raw content", async () => {
    const response = {
      usage: { inputTokens: 100, outputTokens: 50 },
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "SECRET_OUTPUT" }] },
        { type: "function_call", name: "get_weather", arguments: '{"city":"Tokyo"}' },
      ],
    };
    const model = { _model: "gpt-4o", getResponse: vi.fn(async () => response) };
    const wrapped = wrapAgentsModel(model as any, base);
    const res = await wrapped.getResponse({ input: "SECRET_PROMPT", systemInstructions: "sys" } as any);
    expect(res).toBe(response);

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.events[0]).toMatchObject({
      model: "gpt-4o",
      input_tokens: 100,
      output_tokens: 50,
      stream: false,
      tool_calls: ["get_weather"],
    });
    const wire = JSON.stringify(body.events[0]);
    expect(wire).not.toContain("SECRET_PROMPT");
    expect(wire).not.toContain("SECRET_OUTPUT");
    expect(wire).not.toContain("Tokyo");
  });

  it("taps a streamed response and records usage from response_done", async () => {
    async function* gen() {
      yield { type: "output_text_delta", delta: "SECRET_OUTPUT" };
      yield {
        type: "response_done",
        response: {
          usage: { inputTokens: 7, outputTokens: 3 },
          output: [{ type: "function_call", name: "get_weather", arguments: "{}" }],
        },
      };
    }
    const model = { _model: "gpt-4o", getStreamedResponse: () => gen() };
    const wrapped = wrapAgentsModel(model as any, base);

    const seen: any[] = [];
    for await (const e of wrapped.getStreamedResponse({ input: "hi" } as any)) seen.push(e);
    expect(seen).toHaveLength(2);

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.events[0]).toMatchObject({ model: "gpt-4o", input_tokens: 7, output_tokens: 3, stream: true, tool_calls: ["get_weather"] });
  });

  it("refuses a killed agent's getResponse before any spend", async () => {
    vi.stubGlobal("fetch", stubFetch("killed"));
    const getResponse = vi.fn();
    const wrapped = wrapAgentsModel({ _model: "gpt-4o", getResponse } as any, { ...base, killCheck: true });
    await expect(wrapped.getResponse({ input: "hi" } as any)).rejects.toBeInstanceOf(AgentKilledError);
    expect(getResponse).not.toHaveBeenCalled();
  });
});

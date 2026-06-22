import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostControlHandler, wrapModel } from "../src/langchain.js";
import { AgentKilledError } from "../src/index.js";

const base = { agentId: "a1", accKey: "acc_test", endpoint: "https://x.test/v1/events", batchSize: 1, killCheck: false };

function stubFetch(status: "active" | "killed") {
  return vi.fn(async (url: string) => {
    if (String(url).includes("/status")) return new Response(JSON.stringify({ status }), { status: 200 });
    return new Response(null, { status: 200 });
  });
}

describe("langchain handler", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("records usage + tool names from a chat-model run, no raw content", async () => {
    const handler = new CostControlHandler(base);
    handler.handleChatModelStart(
      { id: ["langchain", "chat_models", "openai", "ChatOpenAI"] } as any,
      [[{ _getType: () => "human", content: "SECRET_PROMPT" } as any]],
      "run1",
      undefined,
      { invocation_params: { model: "gpt-4o" } },
    );
    handler.handleLLMEnd(
      {
        generations: [[
          {
            text: "SECRET_OUTPUT",
            message: {
              usage_metadata: { input_tokens: 100, output_tokens: 50 },
              tool_calls: [{ name: "get_weather", args: { city: "Tokyo" } }],
            },
          } as any,
        ]],
        llmOutput: {},
      } as any,
      "run1",
    );

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.events[0]).toMatchObject({
      model: "gpt-4o",
      input_tokens: 100,
      output_tokens: 50,
      stream: false,
      tool_calls: ["get_weather"],
    });
    expect(body.events[0].prompt.roles).toMatchObject({ human: { count: 1 } });
    const wire = JSON.stringify(body.events[0]);
    expect(wire).not.toContain("SECRET_PROMPT");
    expect(wire).not.toContain("SECRET_OUTPUT");
    expect(wire).not.toContain("Tokyo");
  });

  it("falls back to llmOutput.tokenUsage when usage_metadata is absent", async () => {
    const handler = new CostControlHandler(base);
    handler.handleLLMStart({ id: ["X"] } as any, ["hello"], "run2", undefined, { invocation_params: { model: "gpt-4o-mini" } });
    handler.handleLLMEnd(
      { generations: [[{ text: "hi" } as any]], llmOutput: { tokenUsage: { promptTokens: 8, completionTokens: 2 } } } as any,
      "run2",
    );

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.events[0]).toMatchObject({ model: "gpt-4o-mini", input_tokens: 8, output_tokens: 2 });
  });
});

describe("langchain wrapModel kill gate", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses invoke for a killed agent and never calls the model", async () => {
    vi.stubGlobal("fetch", stubFetch("killed"));
    const invoke = vi.fn(async () => "real-response");
    const model = wrapModel({ invoke, model: "gpt-4o" } as any, { ...base, killCheck: true });
    await expect((model as any).invoke("hi")).rejects.toBeInstanceOf(AgentKilledError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes invoke through for an active agent and injects the handler", async () => {
    vi.stubGlobal("fetch", stubFetch("active"));
    const invoke = vi.fn(async (_input: unknown, _config?: unknown) => "real-response");
    const model = wrapModel({ invoke, model: "gpt-4o" } as any, { ...base, killCheck: true });
    const res = await (model as any).invoke("hi");
    expect(res).toBe("real-response");
    const config = (invoke.mock.calls[0] as any[])[1] as any;
    expect(config.callbacks.some((c: any) => c instanceof CostControlHandler)).toBe(true);
  });

  it("survives bindTools: the bound runnable is still gated", async () => {
    vi.stubGlobal("fetch", stubFetch("killed"));
    const invoke = vi.fn(async () => "real-response");
    // bindTools returns a new runnable bound to the model (here, one exposing invoke).
    const fakeModel = { invoke, model: "gpt-4o", bindTools: (_tools: unknown) => ({ invoke }) };
    const bound = (wrapModel(fakeModel as any, { ...base, killCheck: true }) as any).bindTools([]);
    await expect(bound.invoke("hi")).rejects.toBeInstanceOf(AgentKilledError);
    expect(invoke).not.toHaveBeenCalled();
  });
});

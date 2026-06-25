import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withCostControl } from "../src/index.js";

function fakeOpenAI(createImpl: (params: any) => any) {
  const create = vi.fn(createImpl);
  return { apiKey: "sk-fake", chat: { completions: { create } }, create };
}

const base = { agentId: "a1", accKey: "acc_test", batchSize: 1, killCheck: false };

function events() {
  return (fetch as any).mock.calls.flatMap((c: any[]) => JSON.parse(c[1].body).events);
}

describe("routing (OpenAI adapter)", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 }))));
  afterEach(() => vi.unstubAllGlobals());

  it("downshifts a cheap call and records the routed model", async () => {
    const client = fakeOpenAI(async (p: any) => ({ usage: { prompt_tokens: 5, completion_tokens: 5 }, _model: p.model }));
    const wrapped = withCostControl(client as any, { ...base, router: "auto" });

    await wrapped.chat.completions.create({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] });

    // The real call was made with the cheaper model.
    expect(client.create.mock.calls[0]![0].model).toBe("gpt-4o-mini");

    await vi.waitFor(() => expect(events().length).toBe(1));
    const ev = events()[0];
    expect(ev.model).toBe("gpt-4o-mini");
    expect(ev.routing).toMatchObject({ from: "gpt-4", to: "gpt-4o-mini", rule: "auto-downshift", fallback: false });
    expect(ev.sdk_features).toContain("routing");
  });

  it("falls back to the original model when the routed call throws", async () => {
    let calls = 0;
    const client = fakeOpenAI(async (p: any) => {
      calls++;
      if (p.model === "gpt-4o-mini") throw new Error("routed model down");
      return { usage: { prompt_tokens: 5, completion_tokens: 5 } };
    });
    const wrapped = withCostControl(client as any, { ...base, router: "auto" });

    await wrapped.chat.completions.create({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] });
    expect(calls).toBe(2); // routed attempt + original retry

    await vi.waitFor(() => expect(events().length).toBe(1));
    const ev = events()[0];
    expect(ev.model).toBe("gpt-4");
    expect(ev.routing).toMatchObject({ to: "gpt-4", fallback: true });
  });
});

describe("cache (OpenAI adapter)", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 }))));
  afterEach(() => vi.unstubAllGlobals());

  it("replays an identical request from cache and skips the LLM call", async () => {
    const response = { id: "x", usage: { prompt_tokens: 100, completion_tokens: 20 } };
    const client = fakeOpenAI(async () => response);
    const wrapped = withCostControl(client as any, { ...base, cache: { provider: "memory" } });

    const msg = { model: "gpt-4o", messages: [{ role: "user", content: "same question" }] };
    const r1 = await wrapped.chat.completions.create(msg);
    const r2 = await wrapped.chat.completions.create(msg);

    expect(r1).toEqual(response);
    expect(r2).toEqual(response);
    expect(client.create).toHaveBeenCalledTimes(1); // second served from cache

    await vi.waitFor(() => expect(events().length).toBe(2));
    expect(events()[0].cache).toBeUndefined(); // miss
    expect(events()[1].cache).toMatchObject({ hit: true }); // hit
  });

  it("treats a different prompt as a miss", async () => {
    const client = fakeOpenAI(async () => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const wrapped = withCostControl(client as any, { ...base, cache: { provider: "memory" } });

    await wrapped.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "a" }] });
    await wrapped.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "b" }] });
    expect(client.create).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentKilledError, withCostControl } from "../src/index.js";

function fakeOpenAI(usage = { prompt_tokens: 1, completion_tokens: 1 }) {
  const create = vi.fn(async () => ({ id: "x", usage }));
  return { chat: { completions: { create } }, create };
}

const ENDPOINT = "https://x.test/v1/events";

/** Route status checks vs telemetry posts to different canned responses. */
function stubFetch(status: "active" | "killed") {
  return vi.fn(async (url: string) => {
    if (String(url).includes("/status")) {
      return new Response(JSON.stringify({ status }), { status: 200 });
    }
    return new Response(null, { status: 200 }); // telemetry POST
  });
}

const base = { agentId: "bot", accKey: "k", endpoint: ENDPOINT, batchSize: 1 };

describe("soft-kill", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("blocks the call and throws when the agent is killed", async () => {
    vi.stubGlobal("fetch", stubFetch("killed"));
    const client = fakeOpenAI();
    const wrapped = withCostControl(client as any, { ...base, killCheck: true });

    await expect(
      wrapped.chat.completions.create({ model: "gpt-4o", messages: [] }),
    ).rejects.toBeInstanceOf(AgentKilledError);
    expect(client.create).not.toHaveBeenCalled();
  });

  it("allows the call when the agent is active", async () => {
    vi.stubGlobal("fetch", stubFetch("active"));
    const client = fakeOpenAI();
    const wrapped = withCostControl(client as any, { ...base, killCheck: true });

    const res = await wrapped.chat.completions.create({ model: "gpt-4o", messages: [] });
    expect(res.id).toBe("x");
    expect(client.create).toHaveBeenCalledOnce();
  });

  it("checks status by default (killCheck defaults on)", async () => {
    const fetchMock = stubFetch("killed");
    vi.stubGlobal("fetch", fetchMock);
    const client = fakeOpenAI();
    const wrapped = withCostControl(client as any, base); // killCheck omitted → defaults true

    await expect(
      wrapped.chat.completions.create({ model: "gpt-4o", messages: [] }),
    ).rejects.toBeInstanceOf(AgentKilledError);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/status"))).toBe(true);
  });

  it("killCheck:false disables the status check entirely", async () => {
    const fetchMock = stubFetch("killed");
    vi.stubGlobal("fetch", fetchMock);
    const client = fakeOpenAI();
    const wrapped = withCostControl(client as any, { ...base, killCheck: false });

    await wrapped.chat.completions.create({ model: "gpt-4o", messages: [] });
    expect(client.create).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.every(([u]) => !String(u).includes("/status"))).toBe(true);
  });

  it("onKilled returns a fallback instead of throwing (graceful containment)", async () => {
    vi.stubGlobal("fetch", stubFetch("killed"));
    const client = fakeOpenAI();
    const onKilled = vi.fn(() => ({ id: "fallback", killed: true }));
    const wrapped = withCostControl(client as any, { ...base, killCheck: true, onKilled });

    const res = await wrapped.chat.completions.create({ model: "gpt-4o", messages: [] });
    expect(res).toEqual({ id: "fallback", killed: true });
    expect(onKilled).toHaveBeenCalledWith({ agentId: "bot", model: "gpt-4o" });
    expect(client.create).not.toHaveBeenCalled(); // no real call, no spend
  });

  it("caches status so repeated calls hit the endpoint once", async () => {
    const fetchMock = stubFetch("active");
    vi.stubGlobal("fetch", fetchMock);
    const client = fakeOpenAI();
    const wrapped = withCostControl(client as any, { ...base, killCheck: true });

    await wrapped.chat.completions.create({ model: "gpt-4o", messages: [] });
    await wrapped.chat.completions.create({ model: "gpt-4o", messages: [] });

    const statusCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/status"));
    expect(statusCalls).toHaveLength(1);
  });

  it("fails open: a status-check error lets the call through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/status")) throw new Error("network down");
        return new Response(null, { status: 200 });
      }),
    );
    const client = fakeOpenAI();
    const wrapped = withCostControl(client as any, { ...base, killCheck: true });

    const res = await wrapped.chat.completions.create({ model: "gpt-4o", messages: [] });
    expect(res.id).toBe("x");
    expect(client.create).toHaveBeenCalledOnce();
  });
});

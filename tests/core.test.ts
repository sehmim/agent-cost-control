import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSink } from "../src/core.js";
import { AgentKilledError } from "../src/index.js";

const base = { agentId: "a1", accKey: "acc_test", endpoint: "https://x.test/v1/events", batchSize: 1, killCheck: false };

describe("core sink", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("records a normalized CallRecord without leaking raw content", async () => {
    const sink = createSink(base);
    sink.record({
      model: "gpt-4o",
      messages: [{ role: "user", content: "SECRET_PROMPT" }],
      inputTokens: 100,
      outputTokens: 50,
      toolNames: ["get_weather"],
      outputParts: ["SECRET_OUTPUT"],
      stream: false,
      startedAt: Date.now(),
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.events[0]).toMatchObject({
      agent_id: "a1",
      model: "gpt-4o",
      input_tokens: 100,
      output_tokens: 50,
      stream: false,
      tool_calls: ["get_weather"],
    });
    expect(body.events[0].cost_usd).toBeGreaterThan(0);
    expect(body.events[0].prompt).toMatchObject({ message_count: 1, roles: { user: { count: 1 } } });
    expect(body.events[0].output_hash).toHaveLength(64);
    // privacy: no raw prompt or completion content on the wire
    const wire = JSON.stringify(body.events[0]);
    expect(wire).not.toContain("SECRET_PROMPT");
    expect(wire).not.toContain("SECRET_OUTPUT");
  });

  it("isBlocked is false when killCheck is off (no network)", async () => {
    const sink = createSink(base);
    expect(await sink.isBlocked()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocked() throws AgentKilledError with no onKilled handler", () => {
    const sink = createSink(base);
    expect(() => sink.blocked("gpt-4o")).toThrow(AgentKilledError);
  });

  it("blocked() returns the onKilled value when provided", () => {
    const sink = createSink({ ...base, onKilled: () => ({ fallback: true }) });
    expect(sink.blocked("gpt-4o")).toEqual({ fallback: true });
  });

  it("requires agentId and accKey", () => {
    expect(() => createSink({ agentId: "", accKey: "" } as any)).toThrow(/agentId.*accKey/);
  });
});

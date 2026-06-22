import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKilledError, withCostControl } from "../src/index.js";

/**
 * These mirror the flawed agents in /agent-testing-playground, adapted to the
 * real Agent Cost Controller API (monitor + fingerprint + kill + telemetry). Each test
 * asserts the SDK surfaces or stops the waste the corresponding agent creates.
 */

const ENDPOINT = "https://x.test/v1/events";

/** Capture telemetry events and serve a controllable kill status. */
function harness(status: () => "active" | "killed" = () => "active") {
  const events: any[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/status")) {
      return new Response(JSON.stringify({ status: status() }), { status: 200 });
    }
    events.push(...JSON.parse(String(init?.body)).events);
    return new Response(null, { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { events };
}

/** Fake OpenAI client whose usage is derived from the request, like the real API. */
function fakeOpenAI(usageFor: (params: any) => { prompt_tokens: number; completion_tokens: number }) {
  const create = vi.fn(async (params: any) => ({
    id: "cmpl",
    choices: [{ message: { content: "ok" } }],
    usage: usageFor(params),
  }));
  return { chat: { completions: { create } }, create };
}

const opts = (over: object = {}) => ({
  agentId: "test-agent",
  accKey: "acc_test",
  endpoint: ENDPOINT,
  batchSize: 1,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("FLAW 1 — runaway loop (same prompt repeated)", () => {
  it("emits an identical prompt hash every call, so the loop is detectable", async () => {
    const { events } = harness();
    const client = fakeOpenAI(() => ({ prompt_tokens: 10, completion_tokens: 5 }));
    const wrapped = withCostControl(client as any, opts({ agentId: "test-agent-1" }));

    for (let i = 0; i < 5; i++) {
      await wrapped.chat.completions.create({
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello, tell me a joke." }],
      });
    }

    expect(events).toHaveLength(5);
    const hashes = new Set(events.map((e) => e.prompt.hash));
    expect(hashes.size).toBe(1); // every call is the same prompt → loop signal
  });

  it("kill switch blocks the runaway loop (the playground's BudgetExceeded stop)", async () => {
    harness(() => "killed");
    const client = fakeOpenAI(() => ({ prompt_tokens: 10, completion_tokens: 5 }));
    const wrapped = withCostControl(client as any, opts({ agentId: "test-agent-1", killCheck: true }));

    let completed = 0;
    for (let i = 0; i < 100; i++) {
      try {
        await wrapped.chat.completions.create({
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello, tell me a joke." }],
        });
        completed++;
      } catch (err) {
        if (err instanceof AgentKilledError) break;
        throw err;
      }
    }

    expect(completed).toBe(0); // blocked before any spend
    expect(client.create).not.toHaveBeenCalled();
  });
});

describe("FLAW 2 — prompt bloat (history grows every call)", () => {
  it("reports message count and size climbing each call", async () => {
    const { events } = harness();
    const client = fakeOpenAI((p) => ({
      prompt_tokens: JSON.stringify(p.messages).length,
      completion_tokens: 5,
    }));
    const wrapped = withCostControl(client as any, opts({ agentId: "test-agent-2" }));

    const history: any[] = [{ role: "user", content: "Hello" }];
    for (let i = 0; i < 6; i++) {
      history.push({ role: "assistant", content: "Here is my response." });
      history.push({ role: "user", content: "Hello again, " + JSON.stringify(history) });
      await wrapped.chat.completions.create({ model: "gpt-4", messages: history.slice() });
    }

    const counts = events.map((e) => e.prompt.message_count);
    const chars = events.map((e) => e.prompt.total_chars);

    // strictly increasing on both axes → prompt bloat
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThan(counts[i - 1]);
      expect(chars[i]).toBeGreaterThan(chars[i - 1]);
    }
    expect(chars[chars.length - 1]).toBeGreaterThan(chars[0] * 4);
  });
});

describe("FLAW 3 — cost spike (expensive calls pile up)", () => {
  it("records the real per-call cost so spend is attributable", async () => {
    const { events } = harness();
    // gpt-4: $30/1M in, $60/1M out → 1000 in + 5000 out = $0.33/call
    const client = fakeOpenAI(() => ({ prompt_tokens: 1000, completion_tokens: 5000 }));
    const wrapped = withCostControl(client as any, opts({ agentId: "test-agent-3" }));

    for (let i = 0; i < 5; i++) {
      await wrapped.chat.completions.create({
        model: "gpt-4",
        messages: [{ role: "user", content: "Write a 5000-word essay on quantum physics." }],
      });
    }

    for (const e of events) expect(e.cost_usd).toBeCloseTo(0.33, 5);
    const total = events.reduce((s, e) => s + e.cost_usd, 0);
    expect(total).toBeCloseTo(1.65, 5);
  });

  it("a killed agent stops further spend (manual or budget-triggered kill)", async () => {
    const { events } = harness(() => "killed");
    const client = fakeOpenAI(() => ({ prompt_tokens: 1000, completion_tokens: 5000 }));
    const wrapped = withCostControl(client as any, opts({ agentId: "test-agent-3", killCheck: true }));

    await expect(
      wrapped.chat.completions.create({
        model: "gpt-4",
        messages: [{ role: "user", content: "Write a 5000-word essay on quantum physics." }],
      }),
    ).rejects.toBeInstanceOf(AgentKilledError);

    expect(events).toHaveLength(0); // no call, no cost
  });
});

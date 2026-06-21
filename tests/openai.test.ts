import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitor } from "../src/index.js";

/** Minimal stand-in for the OpenAI client shape monitor() detects and intercepts. */
function fakeOpenAI(createImpl: (params: any) => any) {
  const create = vi.fn(createImpl);
  return {
    apiKey: "sk-fake",
    chat: { completions: { create } },
    models: { list: vi.fn(() => "models") },
    create, // exposed for assertions
  };
}

// killCheck off here: these tests assert telemetry/passthrough, not kill behavior.
const baseOpts = { agentId: "a1", helmKey: "ahk_test", batchSize: 1, killCheck: false };

describe("wrapOpenAI", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the response unchanged and records a non-streaming event", async () => {
    const response = {
      id: "cmpl_1",
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    };
    const client = fakeOpenAI(async () => response);
    const wrapped = monitor(client as any, baseOpts);

    const res = await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ],
    });
    expect(res).toBe(response);

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.events[0]).toMatchObject({
      agent_id: "a1",
      model: "gpt-4o",
      input_tokens: 100,
      output_tokens: 50,
      stream: false,
    });
    expect(body.events[0].cost_usd).toBeGreaterThan(0);
    // prompt fingerprint attached, no raw content
    expect(body.events[0].prompt).toMatchObject({
      message_count: 2,
      roles: { system: { count: 1 }, user: { count: 1 } },
    });
    expect(typeof body.events[0].prompt.hash).toBe("string");
    expect(JSON.stringify(body.events[0])).not.toContain("You are helpful.");
  });

  it("records tool-call names (without arguments) from the response", async () => {
    const response = {
      id: "cmpl_2",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } },
              { function: { name: "calculate", arguments: '{"expr":"2+2"}' } },
            ],
          },
        },
      ],
    };
    const client = fakeOpenAI(async () => response);
    const wrapped = monitor(client as any, baseOpts);

    await wrapped.chat.completions.create({ model: "gpt-4o", messages: [], tools: [] });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.events[0].tool_calls).toEqual(["get_weather", "calculate"]);
    // arguments must never be transmitted
    expect(JSON.stringify(body.events[0])).not.toContain("Tokyo");
  });

  it("attaches a one-way output hash without transmitting the completion text", async () => {
    const response = {
      id: "cmpl_3",
      usage: { prompt_tokens: 5, completion_tokens: 5 },
      choices: [{ message: { content: "{ \"name\": \"Ada\" SECRET_OUTPUT }" } }],
    };
    const client = fakeOpenAI(async () => response);
    const wrapped = monitor(client as any, baseOpts);

    await wrapped.chat.completions.create({ model: "gpt-4o", messages: [] });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(typeof body.events[0].output_hash).toBe("string");
    expect(body.events[0].output_hash).toHaveLength(64); // sha-256 hex
    expect(JSON.stringify(body.events[0])).not.toContain("SECRET_OUTPUT");
  });

  it("hashes identical outputs to the same value (stuck-model detection)", async () => {
    const make = () =>
      fakeOpenAI(async () => ({
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        choices: [{ message: { content: "missing comma here" } }],
      }));
    const hashes: string[] = [];
    for (let i = 0; i < 2; i++) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
      const wrapped = monitor(make() as any, baseOpts);
      await wrapped.chat.completions.create({ model: "gpt-4o", messages: [] });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      hashes.push(JSON.parse((fetch as any).mock.calls[0][1].body).events[0].output_hash);
    }
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("passes non-intercepted properties through untouched", () => {
    const client = fakeOpenAI(async () => ({}));
    const wrapped = monitor(client as any, baseOpts);
    expect(wrapped.apiKey).toBe("sk-fake");
    expect((wrapped as any).models.list()).toBe("models");
  });

  it("auto-injects stream_options.include_usage and captures usage from the final chunk", async () => {
    async function* gen() {
      yield { choices: [{ delta: { content: "Hi" } }] };
      yield { choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 3 } };
    }
    const client = fakeOpenAI(async () => gen());
    const wrapped = monitor(client as any, baseOpts);

    const stream = await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [],
      stream: true,
    });

    // create() was called with include_usage injected
    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({ stream_options: { include_usage: true } }),
    );

    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks).toHaveLength(2);

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.events[0]).toMatchObject({
      model: "gpt-4o-mini",
      input_tokens: 7,
      output_tokens: 3,
      stream: true,
    });
  });

  it("does not override an explicit stream_options.include_usage", async () => {
    async function* gen() {
      yield { usage: { prompt_tokens: 1, completion_tokens: 1 } };
    }
    const client = fakeOpenAI(async () => gen());
    const wrapped = monitor(client as any, baseOpts);
    const stream = await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
    });
    for await (const _ of stream) { /* drain */ }
    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({ stream_options: { include_usage: true } }),
    );
  });
});

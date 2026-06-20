import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryQueue } from "../src/telemetry.js";
import type { ResolvedOptions, TelemetryEvent } from "../src/types.js";

function makeOpts(over: Partial<ResolvedOptions> = {}): ResolvedOptions {
  return {
    agentId: "a1",
    helmKey: "ahk_test",
    endpoint: "https://example.test/v1/events",
    flushInterval: 5000,
    batchSize: 50,
    killCheck: false,
    onError: () => {},
    ...over,
  };
}

const event: TelemetryEvent = {
  agent_id: "a1",
  model: "gpt-4o",
  input_tokens: 10,
  output_tokens: 20,
  cost_usd: 0.001,
  latency_ms: 42,
  timestamp: "2026-06-19T00:00:00.000Z",
  sdk_version: "0.1.0",
  stream: false,
};

describe("TelemetryQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("flushes immediately when batchSize is reached", async () => {
    const q = new TelemetryQueue(makeOpts({ batchSize: 2 }));
    q.push(event);
    expect(fetch).not.toHaveBeenCalled();
    q.push(event);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://example.test/v1/events");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer ahk_test",
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.events).toHaveLength(2);
    q.close();
  });

  it("flushes on the timer interval", async () => {
    const q = new TelemetryQueue(makeOpts({ batchSize: 100, flushInterval: 1000 }));
    q.push(event);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledOnce();
    q.close();
  });

  it("manual flush sends buffered events", async () => {
    const q = new TelemetryQueue(makeOpts({ batchSize: 100 }));
    q.push(event);
    await q.flush();
    expect(fetch).toHaveBeenCalledOnce();
    q.close();
  });

  it("no-op flush when empty", async () => {
    const q = new TelemetryQueue(makeOpts());
    await q.flush();
    expect(fetch).not.toHaveBeenCalled();
    q.close();
  });

  it("routes network errors to onError and never throws", async () => {
    const onError = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const q = new TelemetryQueue(makeOpts({ batchSize: 1, onError }));
    q.push(event);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]![0].message).toBe("network down");
    q.close();
  });

  it("reports non-2xx responses via onError", async () => {
    const onError = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    const q = new TelemetryQueue(makeOpts({ batchSize: 1, onError }));
    q.push(event);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]![0].message).toContain("500");
    q.close();
  });
});

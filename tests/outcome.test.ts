import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportOutcome, outcomesUrlFrom } from "../src/index.js";

describe("reportOutcome", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("derives the outcomes URL from the events endpoint", () => {
    expect(outcomesUrlFrom("https://x.dev/v1/events")).toBe("https://x.dev/v1/outcomes");
    expect(outcomesUrlFrom("https://x.dev/v1/events/")).toBe("https://x.dev/v1/outcomes");
    expect(outcomesUrlFrom("https://x.dev/base")).toBe("https://x.dev/base/outcomes");
  });

  it("POSTs the outcome with a bearer header and a timestamp", async () => {
    await reportOutcome("success", {
      agentId: "a1",
      accKey: "acc_test",
      endpoint: "http://localhost:3000/v1/events",
      workflow: "checkout",
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toBe("http://localhost:3000/v1/outcomes");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer acc_test");

    const body = JSON.parse(init.body);
    expect(body.outcomes[0]).toMatchObject({
      agent_id: "a1",
      outcome: "success",
      workflow: "checkout",
    });
    expect(typeof body.outcomes[0].timestamp).toBe("string");
  });

  it("omits workflow when not supplied", async () => {
    await reportOutcome("rework", { agentId: "a1", accKey: "acc_test" });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.outcomes[0]).not.toHaveProperty("workflow");
  });

  it("fails open when fetch rejects (never throws)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(
      reportOutcome("failure", { agentId: "a1", accKey: "acc_test" }),
    ).resolves.toBeUndefined();
  });

  it("does nothing without agentId/accKey", async () => {
    await reportOutcome("success", { agentId: "", accKey: "" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { withCostControl } from "../src/index.js";

function fakeOpenAI() {
  return { chat: { completions: { create: async () => ({}) } } };
}

describe("monitor", () => {
  it("requires agentId and accKey", () => {
    expect(() => withCostControl(fakeOpenAI() as any, { agentId: "", accKey: "" } as any)).toThrow(
      /agentId.*accKey/,
    );
  });

  it("returns a client exposing the same create method shape", () => {
    const wrapped = withCostControl(fakeOpenAI() as any, { agentId: "a", accKey: "k" });
    expect(typeof wrapped.chat.completions.create).toBe("function");
  });

  it("throws on an unsupported client", () => {
    expect(() => withCostControl({ foo: 1 } as any, { agentId: "a", accKey: "k" })).toThrow(
      /unsupported client/,
    );
  });
});

import { describe, expect, it } from "vitest";
import { monitor } from "../src/index.js";

function fakeOpenAI() {
  return { chat: { completions: { create: async () => ({}) } } };
}

describe("monitor", () => {
  it("requires agentId and helmKey", () => {
    expect(() => monitor(fakeOpenAI() as any, { agentId: "", helmKey: "" } as any)).toThrow(
      /agentId.*helmKey/,
    );
  });

  it("returns a client exposing the same create method shape", () => {
    const wrapped = monitor(fakeOpenAI() as any, { agentId: "a", helmKey: "k" });
    expect(typeof wrapped.chat.completions.create).toBe("function");
  });

  it("throws on an unsupported client", () => {
    expect(() => monitor({ foo: 1 } as any, { agentId: "a", helmKey: "k" })).toThrow(
      /unsupported client/,
    );
  });
});

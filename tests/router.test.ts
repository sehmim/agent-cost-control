import { describe, expect, it } from "vitest";
import { route, estimateTokens, type RoutePolicy } from "../src/index.js";

const short = [{ role: "user", content: "hi" }];
const long = [{ role: "user", content: "x".repeat(40_000) }]; // ~10k tokens

describe("route() — auto heuristic", () => {
  it("downshifts a cheap, tool-free call to the mini tier", () => {
    const d = route("auto", { model: "gpt-4", messages: short, toolCount: 0 });
    expect(d.selectedModel).toBe("gpt-4o-mini");
    expect(d.ruleMatched).toBe("auto-downshift");
    expect(d.fallback).toBe(false);
  });

  it("keeps the original model when tools are present", () => {
    const d = route("auto", { model: "gpt-4", messages: short, toolCount: 2 });
    expect(d.selectedModel).toBe("gpt-4");
    expect(d.ruleMatched).toBeNull();
  });

  it("keeps the original model for large prompts", () => {
    const d = route("auto", { model: "gpt-4", messages: long, toolCount: 0 });
    expect(d.selectedModel).toBe("gpt-4");
  });

  it("leaves models with no cheaper sibling untouched", () => {
    const d = route("auto", { model: "gpt-4o-mini", messages: short, toolCount: 0 });
    expect(d.selectedModel).toBe("gpt-4o-mini");
    expect(d.ruleMatched).toBeNull();
  });
});

describe("route() — explicit policy", () => {
  const policy: RoutePolicy = {
    routes: [
      { name: "tiny", condition: { type: "token_estimate", max: 100 }, targetModel: "gpt-4o-mini", priority: 1 },
      { name: "no-tools", condition: { type: "tool_count", max: 0 }, targetModel: "gpt-4o", priority: 10 },
    ],
  };

  it("checks higher-priority rules first", () => {
    const d = route(policy, { model: "gpt-4", messages: short, toolCount: 0 });
    expect(d.ruleMatched).toBe("no-tools");
    expect(d.selectedModel).toBe("gpt-4o");
  });

  it("falls through to a lower-priority rule when the first misses", () => {
    const d = route(policy, { model: "gpt-4", messages: short, toolCount: 3 });
    expect(d.ruleMatched).toBe("tiny");
    expect(d.selectedModel).toBe("gpt-4o-mini");
  });

  it("returns the original model when nothing matches", () => {
    const d = route(policy, { model: "gpt-4", messages: long, toolCount: 3 });
    expect(d.selectedModel).toBe("gpt-4");
    expect(d.ruleMatched).toBeNull();
  });
});

describe("estimateTokens()", () => {
  it("scales with content size and is ~0 for empty input", () => {
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short));
  });
});

import { describe, expect, it, vi } from "vitest";
import { calculateCost } from "../src/pricing.js";

describe("calculateCost", () => {
  it("computes cost for a known model", () => {
    // gpt-4o: 2.5/M input, 10/M output
    const cost = calculateCost("gpt-4o", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(12.5, 6);
  });

  it("handles zero tokens", () => {
    expect(calculateCost("gpt-4o-mini", 0, 0)).toBe(0);
  });

  it("returns 0 and reports via onError for an unknown model", () => {
    const onError = vi.fn();
    expect(calculateCost("made-up-model", 100, 100, onError)).toBe(0);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});

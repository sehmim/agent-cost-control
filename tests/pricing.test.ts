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

  it("falls back to a conservative non-zero rate for an unknown model, and warns", () => {
    const onError = vi.fn();
    // Fallback is gpt-4 level (30/M in, 60/M out): 1M+1M tokens = $90.
    const cost = calculateCost("made-up-model", 1_000_000, 1_000_000, onError);
    expect(cost).toBeCloseTo(90, 6);
    expect(cost).toBeGreaterThan(0); // never silently $0 — budgets must still trip
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it("never under-bills an unknown model below the priciest known model", () => {
    const unknown = calculateCost("brand-new-model", 1000, 1000);
    const knownMax = calculateCost("gpt-4", 1000, 1000); // priciest in PRICING
    expect(unknown).toBeGreaterThanOrEqual(knownMax);
  });
});

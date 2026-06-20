import { describe, expect, it } from "vitest";
import { fingerprintMessages } from "../src/fingerprint.js";

describe("fingerprintMessages", () => {
  it("breaks down message count, roles, and sizes", () => {
    const fp = fingerprintMessages([
      { role: "system", content: "You are helpful." }, // 16
      { role: "user", content: "Hi" }, // 2
      { role: "assistant", content: "Hello!" }, // 6
      { role: "user", content: "Bye" }, // 3
    ])!;
    expect(fp.message_count).toBe(4);
    expect(fp.total_chars).toBe(27);
    expect(fp.roles.system).toEqual({ count: 1, chars: 16 });
    expect(fp.roles.user).toEqual({ count: 2, chars: 5 });
    expect(fp.roles.assistant).toEqual({ count: 1, chars: 6 });
  });

  it("hashes identical prompts to the same digest (catches loops)", () => {
    const msgs = [{ role: "user", content: "repeat me" }];
    expect(fingerprintMessages(msgs)!.hash).toBe(fingerprintMessages([...msgs])!.hash);
  });

  it("hashes different prompts differently", () => {
    const a = fingerprintMessages([{ role: "user", content: "a" }])!.hash;
    const b = fingerprintMessages([{ role: "user", content: "b" }])!.hash;
    expect(a).not.toBe(b);
  });

  it("does not embed raw content in the output", () => {
    const secret = "super-secret-prompt-text";
    const fp = fingerprintMessages([{ role: "user", content: secret }])!;
    expect(JSON.stringify(fp)).not.toContain(secret);
  });

  it("handles non-string (multimodal) content without crashing", () => {
    const fp = fingerprintMessages([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ])!;
    expect(fp.message_count).toBe(1);
    expect(fp.roles.user!.chars).toBeGreaterThan(0);
  });

  it("returns undefined when messages is not an array", () => {
    expect(fingerprintMessages(undefined)).toBeUndefined();
    expect(fingerprintMessages("nope")).toBeUndefined();
  });

  it("labels missing roles as unknown", () => {
    const fp = fingerprintMessages([{ content: "x" }])!;
    expect(fp.roles.unknown).toEqual({ count: 1, chars: 1 });
  });
});

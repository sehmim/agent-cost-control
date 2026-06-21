import { createHash } from "node:crypto";
import type { PromptFingerprint } from "./types.js";

/** A chat message as far as fingerprinting cares — role + arbitrary content. */
interface Message {
  role?: string;
  content?: unknown;
}

/** Approximate the character size of a message's content (handles string, multimodal array, null). */
function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (content == null) return 0;
  return JSON.stringify(content).length;
}

/**
 * Derive a privacy-safe fingerprint of a prompt: message count, per-role
 * count/size breakdown, total size, and a stable one-way hash of the message
 * array. Carries NO raw prompt content — enough to spot bloat (growing size),
 * loops (recurring hash), and a fat system prompt (per-role chars), nothing more.
 */
export function fingerprintMessages(messages: unknown): PromptFingerprint | undefined {
  if (!Array.isArray(messages)) return undefined;

  const roles: Record<string, { count: number; chars: number }> = {};
  let totalChars = 0;

  for (const msg of messages as Message[]) {
    const role = typeof msg?.role === "string" ? msg.role : "unknown";
    const chars = contentChars(msg?.content);
    totalChars += chars;
    const bucket = roles[role] ?? (roles[role] = { count: 0, chars: 0 });
    bucket.count += 1;
    bucket.chars += chars;
  }

  // Hash the structural content so identical/near-identical prompts collide,
  // without the digest being reversible to the original text.
  const hash = createHash("sha256")
    .update(JSON.stringify((messages as Message[]).map((m) => [m?.role, m?.content])))
    .digest("hex");

  return {
    message_count: (messages as unknown[]).length,
    total_chars: totalChars,
    roles,
    hash,
  };
}

/**
 * One-way hash of an LLM's output (completion text and/or tool-call JSON). Like
 * the prompt hash, it carries NO recoverable content — identical outputs collide,
 * which is enough to spot a model stuck emitting the same (often malformed) answer.
 * Returns undefined when there's no output to hash.
 */
export function hashOutput(parts: string[]): string | undefined {
  const joined = parts.filter((p) => p && p.length > 0).join(" ");
  if (!joined) return undefined;
  return createHash("sha256").update(joined).digest("hex");
}

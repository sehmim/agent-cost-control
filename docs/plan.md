# agentfinops-node — Build Plan

## What This Is

A lightweight Node/TypeScript SDK that wraps existing OpenAI and Anthropic clients to extract token usage metadata from LLM responses and fire it async to a telemetry endpoint. Never touches API keys, prompts, or completions.

## Developer Experience (Target API)

```typescript
import { wrap } from "agentfinops";
import OpenAI from "openai";

const client = wrap(new OpenAI({ apiKey: "sk-their-key" }), {
  agentId: "support-bot",
  finopsKey: "afk_abc123",
  // endpoint: "https://api.yourdomain.com/v1/events"  (default)
  // killCheck: false  (default)
  // flushInterval: 5000  (default, ms)
  // batchSize: 50  (default)
});

// Everything else unchanged — same types, same return values
const res = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
});
```

Anthropic equivalent:

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = wrap(new Anthropic({ apiKey: "sk-ant-..." }), {
  agentId: "research-agent",
  finopsKey: "afk_abc123",
});

const res = await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
});
```

## Project Structure

```
agentfinops-node/
├── CLAUDE.md              # paste the updated CLAUDE.md from the project
├── package.json           # name: "agentfinops", type: "module"
├── tsconfig.json          # target ES2020, strict, dual CJS+ESM output
├── tsup.config.ts         # bundle with tsup → dist/index.mjs + dist/index.cjs
├── src/
│   ├── index.ts           # re-exports wrap, flush, types
│   ├── wrap.ts            # wrap() function — detects client type, returns proxied client
│   ├── openai.ts          # OpenAI-specific interception logic
│   ├── anthropic.ts       # Anthropic-specific interception logic
│   ├── telemetry.ts       # batched async event queue + HTTP dispatch
│   ├── kill.ts            # soft-kill check (GET /v1/agents/{id}/status)
│   ├── pricing.ts         # model → cost-per-token lookup table
│   └── types.ts           # TelemetryEvent, WrapOptions, etc.
├── tests/
│   ├── wrap.test.ts       # wrap returns a client with identical interface
│   ├── openai.test.ts     # non-streaming + streaming interception
│   ├── anthropic.test.ts  # non-streaming + streaming interception
│   ├── telemetry.test.ts  # batching, flushing, retry
│   └── kill.test.ts       # soft-kill blocks call when killed
└── README.md
```

## Build Order (6 Steps)

### Step 1: Scaffold + Tooling

- `package.json` with `openai` and `@anthropic-ai/sdk` as **peer dependencies** (not bundled)
- `tsup` for dual CJS/ESM build
- `vitest` for tests
- Exports: `"."` → `dist/index.mjs` (import), `dist/index.cjs` (require)

### Step 2: Types + Telemetry Queue

**`types.ts`** — define:
```typescript
interface TelemetryEvent {
  agent_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  timestamp: string;
  sdk_version: string;
  stream: boolean;
}

interface WrapOptions {
  agentId: string;
  finopsKey: string;
  endpoint?: string;       // default: "https://api.agentfinops.dev/v1/events"
  killCheck?: boolean;     // default: false
  flushInterval?: number;  // default: 5000ms
  batchSize?: number;      // default: 50
  onError?: (err: Error) => void;  // swallow by default
}
```

**`telemetry.ts`** — the event queue:
- Holds events in an in-memory array
- Flushes via `POST /v1/events` when array hits `batchSize` OR every `flushInterval` ms
- Uses `setInterval` for timer-based flush, clears on `flush()` call
- HTTP via native `fetch` (Node 18+)
- Fire-and-forget: errors are caught and passed to `onError` callback, never thrown
- Expose `flush()` for graceful shutdown (`process.on("beforeExit", flush)`)
- Include `Authorization: Bearer ${finopsKey}` header

### Step 3: Pricing Table

**`pricing.ts`** — a static lookup:
- Map of `model_name → { input_per_token: number, output_per_token: number }`
- Cover major models: gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-3.5-turbo, claude-sonnet-4-6, claude-opus-4, claude-haiku-3-5
- Export a `calculateCost(model, inputTokens, outputTokens) → number` function
- If model not found, return `0` and log a warning — don't crash

### Step 4: OpenAI Interception

**`openai.ts`** — intercept `client.chat.completions.create()`:

**Non-streaming (`stream: false` or omitted):**
1. Record `startTime`
2. Call original method
3. Read `response.usage.prompt_tokens` and `response.usage.completion_tokens`
4. Build `TelemetryEvent`, push to queue
5. Return original response unmodified

**Streaming (`stream: true`):**
1. Record `startTime`
2. Call original method — returns an async iterable `Stream<ChatCompletionChunk>`
3. Wrap the stream in a new async generator that yields every chunk unchanged
4. On the final chunk, check for `usage` field (OpenAI includes it when `stream_options: { include_usage: true }`)
5. If usage present, build event and push to queue
6. If usage not present (user didn't set `include_usage`), auto-inject `stream_options: { include_usage: true }` into the request params before calling original — this is the key trick

**Implementation approach:**
- Use a `Proxy` on the client object
- Trap `get` on `client.chat` → return a proxy
- Trap `get` on `client.chat.completions` → return a proxy
- Trap `get` on `client.chat.completions.create` → return the wrapped function
- Everything else passes through untouched so the client behaves identically

### Step 5: Anthropic Interception

**`anthropic.ts`** — intercept `client.messages.create()`:

**Non-streaming:**
1. Record `startTime`
2. Call original
3. Read `response.usage.input_tokens` and `response.usage.output_tokens`
4. Build event, push to queue
5. Return response unmodified

**Streaming (`stream: true`):**
1. Call original — returns a `MessageStream`
2. Wrap it: on `message_stop` event or the final `message_delta` event, read the accumulated usage
3. Anthropic streaming emits `usage` in `message_start` (input) and `message_delta` (output) — capture both
4. Push event to queue after stream ends

**Proxy approach:** same pattern as OpenAI but trap `client.messages.create`.

### Step 6: wrap() + Soft Kill

**`wrap.ts`:**
- Detect client type: `instanceof OpenAI` → use OpenAI interceptor, check for `.messages.create` method → use Anthropic interceptor
- Initialize telemetry queue with the provided options
- Return proxied client
- Register `process.on("beforeExit", () => flush())` on first wrap call

**`kill.ts`** (opt-in):
- If `killCheck: true`, before each intercepted call, do `GET /v1/agents/{agentId}/status`
- If response is `{ "status": "killed" }`, throw `AgentKilledException` instead of making the LLM call
- Cache the status for 10s to avoid per-request latency
- If the check fails (network error), proceed with the call — fail open, not closed

## Key Rules

1. **Never access or transmit**: prompt content, completion content, API keys, or any request/response body beyond the `usage` object
2. **Never add latency** to the LLM call — all telemetry is post-response and async
3. **Return types must be identical** — `wrap()` must not break TypeScript types. The returned client should have the same type signature as the original
4. **Peer dependencies only** — don't bundle `openai` or `@anthropic-ai/sdk`. User brings their own version
5. **Node 18+ only** — use native `fetch`, no axios/node-fetch dependency
6. **Zero config works** — only `agentId` and `finopsKey` are required

## Testing Strategy

- Mock the LLM SDKs — don't make real API calls in tests
- Mock `fetch` to assert telemetry payloads are correct
- Test: non-streaming OpenAI, streaming OpenAI, non-streaming Anthropic, streaming Anthropic
- Test: batching flushes at batchSize, timer flushes at interval, manual flush
- Test: soft-kill blocks call, soft-kill cache expires, soft-kill fails open
- Test: unknown model returns cost 0
- Test: wrap() returns same type (compile-time check)
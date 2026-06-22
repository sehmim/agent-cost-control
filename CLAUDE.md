# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`agent-cost-controller` — a lightweight Node/TypeScript SDK that wraps an existing AI client/model to extract token-usage metadata from responses and ship it asynchronously to a telemetry endpoint. It never touches API keys, prompt content, or completion content — only the `usage` object. One package, four framework adapters behind subpath imports:

| Framework | Subpath | Entry |
| --------- | ------- | ----- |
| OpenAI | `agent-cost-controller` | `withCostControl(client, opts)` |
| Vercel AI SDK / Mastra | `agent-cost-controller/ai` | `withCostControl(model, opts)`, `costControlMiddleware(opts)` |
| LangChain.js / LangGraph.js | `agent-cost-controller/langchain` | `wrapModel(model, opts)`, `CostControlHandler` |
| OpenAI Agents SDK | `agent-cost-controller/agents` | `wrapAgentsModel(model, opts)` |

```typescript
import { withCostControl } from "agent-cost-controller";
import OpenAI from "openai";

const client = withCostControl(new OpenAI({ apiKey }), { agentId: "support-bot", accKey: "acc_..." });
// identical interface — usage is recorded behind the scenes
const res = await client.chat.completions.create({ model: "gpt-4o", messages });
```

## Commands

- `npm test` — run vitest suite once
- `npm run test:watch` — vitest watch mode
- `npx vitest run tests/openai.test.ts` — single test file
- `npm run build` — tsup → `dist/index.{mjs,cjs,d.ts}`
- `npm run typecheck` — `tsc --noEmit`

## Architecture

`src/core.ts` is the framework-agnostic heart. `createSink()` validates options, fills defaults (`resolveOptions`), builds one `TelemetryQueue` + `KillSwitch`, and registers the one-time `beforeExit` flush (`keepAlive`). A `Sink` exposes the three things every adapter needs: `isBlocked()` (kill check), `blocked(model)` (throw `AgentKilledError`, or run `onKilled` and return its value), and `record(rec: CallRecord)` — which fingerprints the prompt, hashes the output, computes cost, and pushes a `TelemetryEvent`. **`CallRecord`** is the normalized shape every adapter produces: `{ model, messages?, inputTokens, outputTokens, toolNames?, outputParts?, stream, startedAt }`. Adding a framework = a new file that hooks the call, gates on `isBlocked`/`blocked`, and feeds `record()` — never re-implement the pipeline.

`src/monitor.ts` (OpenAI) builds a Sink, then `intercept()` proxies three levels — `client → chat → completions` — via the small `swap()` helper, replacing only `create` and passing everything else through (methods stay `.bind`-ed so `this` is correct). `traceCreate` runs the real call, then records usage **after** the response: non-streaming reads `usage` off the result; streaming auto-injects `stream_options.include_usage` and reads `usage` off the carrying chunk via a pass-through async generator.

`src/ai.ts` (Vercel AI SDK + Mastra) returns a `LanguageModelMiddleware` (`specificationVersion: "v3"`) with `wrapGenerate`/`wrapStream`; `withCostControl(model, opts)` is the `wrapLanguageModel` convenience. Mastra needs no separate code — pass the wrapped model to its `Agent`. `src/langchain.ts` ships `CostControlHandler` (a `BaseCallbackHandler` for telemetry) + `wrapModel` (a Proxy that gates `invoke`/`stream`/`batch` on the kill switch and injects the handler), because LangChain callbacks observe but cannot block. `src/agents.ts` wraps an Agents SDK `Model`, intercepting `getResponse`/`getStreamedResponse`. All three read usage **version-tolerantly** (`inputTokens ?? promptTokens`, etc.) and pull tool **names** + hashable output structurally by `.type`.

`src/consts.ts` holds every tunable: `SDK_VERSION`, `DEFAULT_ENDPOINT`, the flush/batch defaults, and the `PRICING` table.

`src/telemetry.ts` (`TelemetryQueue`) buffers events, flushes on `batchSize` or a `setInterval` (`unref`'d so it never holds the process open), and POSTs `{ events }` with a Bearer header via native `fetch`. All dispatch errors route to `onError` — never thrown into the caller's path. `monitor.ts` registers a one-time `beforeExit` flush.

`src/pricing.ts` is `calculateCost` over the `PRICING` table from consts. An unknown model falls back to a deliberately high conservative rate (`FALLBACK_RATE`, ≈ gpt-4) and warns via `onError` — **never `0`**, so budgets still trip for un-priced/new models. Never throws.

`src/fingerprint.ts` (`fingerprintMessages`) turns the request `messages` into a `PromptFingerprint`: message count, per-role count/char breakdown, total chars, and a SHA-256 hash of the message array. **No raw prompt content** — the hash is one-way (catches repeated/looping prompts), sizes catch bloat/fat system prompts. Always attached to the event when `messages` is an array.

## Key Rules

1. **Never** transmit raw prompt content, completions, or API keys. What leaves the client: the `usage` object, a content-free `PromptFingerprint` (sizes + one-way hash), tool-call **names** (never arguments), and a one-way `output_hash` of the completion (identical outputs collide, the text is not recoverable). This holds for **every** adapter — they all funnel through `Sink.record(CallRecord)`.
2. **Never** add latency to the LLM call — all telemetry is post-response and async.
3. Wrapped client/model must keep **identical return types** — pass results through untouched; don't break the framework's type signature.
4. Every framework (`openai`, `ai`, `@langchain/core`, `@openai/agents`) is an **optional peer dependency** — never bundle it; the user brings their own version. tsup externalizes them automatically.
5. **Node 18+** — use native `fetch`, no axios/node-fetch.
6. **Zero-config** — only `agentId` and `accKey` are required.

## Soft-kill

`src/kill.ts` (`KillSwitch`) backs the `killCheck` option (**default true**). When on,
every call first asks the status endpoint (`…/agents/<id>/status`, derived from
`endpoint`) whether the agent is killed. Status is cached for `KILL_CACHE_MS` and **fails
open** — any lookup error is treated as "not killed" so infra problems never block real
work. Set `killCheck: false` to skip the lookup entirely (zero network cost).

Default-on is safe because an agent is only ever reported killed once you've set a budget
+ auto-stop in the dashboard and spend crossed it — with no budget the backend never
returns `killed`, so the check is inert.

**Containment.** When a killed agent's call is blocked (`monitor.ts` → `blocked()`):
- if `onKilled(info)` is set, it runs and its return value becomes the call's response —
  so one killed (sub)agent degrades gracefully instead of throwing into the host;
- otherwise `AgentKilledError` is thrown to halt the loop.

Either way the real LLM call is never made (no spend), and only the killed agent's own
client is affected — killing agent X never touches agent Y. Streaming: a killed agent
returns an empty stream (after running `blocked()`), so `for await` just ends. The SDK's
own async work (telemetry flush, status poll) always swallows its errors, so it never
emits an unhandled rejection that could crash the process.

## Deferred (not yet built)

Direct Anthropic interception (`src/anthropic.ts` + `@anthropic-ai/sdk` peer dep). The
`CallRecord`/`Sink` seam in `core.ts` makes this a thin adapter. (Anthropic via the Vercel
AI SDK or Mastra already works today through `agent-cost-controller/ai`.) See `plan.md` for
the full original spec.

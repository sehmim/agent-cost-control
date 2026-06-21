# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`agenthelm` — a lightweight Node/TypeScript SDK that wraps an existing OpenAI client to extract token-usage metadata from responses and ship it asynchronously to a telemetry endpoint. It never touches API keys, prompt content, or completion content — only the `usage` object.

```typescript
import { monitor } from "agenthelm";
import OpenAI from "openai";

const client = monitor(new OpenAI({ apiKey }), { agentId: "support-bot", helmKey: "ahk_..." });
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

`src/monitor.ts` is the whole entry path: `monitor()` validates options, fills defaults, creates one `TelemetryQueue`, and returns the intercepted client. `intercept()` proxies three levels — `client → chat → completions` — via the small `swap()` helper, replacing only `create` and passing everything else through (methods stay `.bind`-ed so `this` is correct). `traceCreate` runs the real call, then records usage **after** the response: non-streaming reads `usage` off the result; streaming auto-injects `stream_options.include_usage` and reads `usage` off the carrying chunk via a pass-through async generator. `emit()` builds the `TelemetryEvent` and pushes it.

`src/consts.ts` holds every tunable: `SDK_VERSION`, `DEFAULT_ENDPOINT`, the flush/batch defaults, and the `PRICING` table.

`src/telemetry.ts` (`TelemetryQueue`) buffers events, flushes on `batchSize` or a `setInterval` (`unref`'d so it never holds the process open), and POSTs `{ events }` with a Bearer header via native `fetch`. All dispatch errors route to `onError` — never thrown into the caller's path. `monitor.ts` registers a one-time `beforeExit` flush.

`src/pricing.ts` is just `calculateCost` over the `PRICING` table from consts; unknown model → `0` + warning, never throws.

`src/fingerprint.ts` (`fingerprintMessages`) turns the request `messages` into a `PromptFingerprint`: message count, per-role count/char breakdown, total chars, and a SHA-256 hash of the message array. **No raw prompt content** — the hash is one-way (catches repeated/looping prompts), sizes catch bloat/fat system prompts. Always attached to the event when `messages` is an array.

## Key Rules

1. **Never** transmit raw prompt content, completions, or API keys. What leaves the client: the `usage` object, a content-free `PromptFingerprint` (sizes + one-way hash), tool-call **names** (never arguments), and a one-way `output_hash` of the completion (identical outputs collide, the text is not recoverable).
2. **Never** add latency to the LLM call — all telemetry is post-response and async.
3. Wrapped client must keep **identical return types** — don't break the OpenAI type signature.
4. `openai` is a **peer dependency** — never bundle it; the user brings their own version.
5. **Node 18+** — use native `fetch`, no axios/node-fetch.
6. **Zero-config** — only `agentId` and `helmKey` are required.

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

Anthropic interception (`src/anthropic.ts` + `@anthropic-ai/sdk` peer dep). `monitor()`'s
dispatch and `MonitorOptions` leave a clean seam. See `plan.md` for the full original spec.

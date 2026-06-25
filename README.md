<div align="center">

<pre>
                    .-"""""""-.
                 .-'  .     .  '-.
               .'   .---. .---.   '.
              /    / o   |   o \    \
             |    |   .--'--.   |    |
             |     '--'     '--'     |
             |    .-"""""""""""-.    |
             |   / \/\/\/\/\/\/\ \   |
              \ |  C H O M P !!!  | /
               \ \ /\/\/\/\/\/\/ / /
                '.'-.._______..-'.'
                  '-.   \   /  .-'
                     \   \ /  /
            ~~vine~~  \   |  /  ~~vine~~
                  .----'--+--'----.
                   \    A C C     /
                    \____ 67 ____/
                     '-----------'
</pre>

# 🌱 Agent Cost Controller

**Integrate once, then forget it.** Wrap your existing LLM client in a single line and
Agent Cost Controller automatically meters every call — tokens, cost, latency, prompt
shape, and tool usage — and streams it to a live dashboard. No rewrites, no per-call
instrumentation.

From there it becomes a control plane: set **budgets** and **hard call caps**, **auto-stop**
runaway agents, surface **loops and prompt bloat**, **route** cheap calls to cheaper models,
and **cache** repeat responses in your own database — all without touching your code again.

It never sees your API keys, prompts, or completions, and never adds latency to a call.

[![npm version](https://img.shields.io/npm/v/agent-cost-controller.svg?color=2e8b57&label=npm)](https://www.npmjs.com/package/agent-cost-controller)
[![node](https://img.shields.io/node/v/agent-cost-controller.svg?color=2e8b57)](https://nodejs.org)
[![license: MIT](https://img.shields.io/npm/l/agent-cost-controller.svg?color=2e8b57)](./LICENSE)
[![types: included](https://img.shields.io/npm/types/agent-cost-controller.svg?color=2e8b57)](https://www.typescriptlang.org)

</div>

---

## 🌿 Capabilities

| | |
| --- | --- |
| 🪴 **Integrate &amp; forget** | One-line wrap — `withCostControl(client, opts)` — keeps the same methods, types, and return values. Every call after that is metered automatically and reported to the dashboard. |
| 📊 **Automatic monitoring** | Per-call tokens, cost, latency, model, a content-free prompt fingerprint, tool **names**, and an output hash — attributed per agent, no manual logging. |
| 🔒 **Privacy-first** | Ships only the `usage` object plus content-free metadata. Raw prompts, completions, and API keys never leave the process. |
| ⚡ **Zero latency** | Telemetry is read **after** the response and flushed fire-and-forget. Never blocks, never throws into your request path. |
| 🦷 **Budgets &amp; auto-stop** | Set a spend budget or hard call cap in the dashboard; the kill switch halts a runaway agent mid-loop — `AgentKilledError` (or a graceful fallback) instead of another expensive call. |
| 🔁 **Waste detection** | Loops, prompt bloat, call spikes, and stuck retries are detected from the fingerprint stream and surfaced as dashboard alerts with estimated savings. |
| 💸 **Model routing** | Optionally downshift cheap, simple calls to a cheaper model — automatically, or by an explicit policy. |
| 🗄️ **Response cache (BYO DB)** | Replay identical requests for $0 from memory, your own Redis/Upstash, or a hosted store — configurable per agent from the dashboard. |
| 📈 **Cost per success** | `reportOutcome()` marks a completion `success`/`failure`/`rework` so the dashboard tracks **cost ÷ successful completions**, not just raw tokens. |
| 🌎 **Framework-agnostic** | OpenAI · Vercel AI SDK · Mastra · LangChain.js / LangGraph.js · OpenAI Agents SDK — one shared, privacy-safe pipeline. |

## 🪴 Install

```bash
npm install agent-cost-controller
# plus whichever framework you already use:
#   openai · ai · @langchain/core · @openai/agents
```

Requires **Node 18+**. Every framework is an _optional_ peer dependency — install
only the one you use and import from the matching subpath:

| Framework | Import | Wrapper |
| --------- | ------ | ------- |
| OpenAI | `agent-cost-controller` | `withCostControl(client, opts)` |
| Vercel AI SDK / Mastra | `agent-cost-controller/ai` | `withCostControl(model, opts)` |
| LangChain.js / LangGraph.js | `agent-cost-controller/langchain` | `wrapModel(model, opts)` / `CostControlHandler` |
| OpenAI Agents SDK | `agent-cost-controller/agents` | `wrapAgentsModel(model, opts)` |

All adapters feed the **same** privacy-safe pipeline, so the guarantees above hold everywhere.

## 🌍 Frameworks

The same `agentId` / `accKey` / kill-switch options apply to every adapter below.

<details open>
<summary><b>OpenAI</b></summary>

```typescript
import { withCostControl } from "agent-cost-controller";
import OpenAI from "openai";

const client = withCostControl(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), {
  agentId: "support-bot",
  accKey: "acc_abc123",
});

// Everything else is unchanged — same methods, same types, same return values.
const res = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
});
```

Streaming works too — the SDK auto-requests usage stats and reads them off the final chunk:

```typescript
const stream = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

</details>

<details>
<summary><b>Vercel AI SDK</b></summary>

Wrap any model and hand it to `generateText` / `streamText`:

```typescript
import { withCostControl } from "agent-cost-controller/ai";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

const model = withCostControl(openai("gpt-4o"), { agentId: "support-bot", accKey: "acc_…" });
await generateText({ model, prompt: "Hello" });
```

</details>

<details>
<summary><b>Mastra</b></summary>

Mastra is built on the Vercel AI SDK, so the same wrapper works — pass the wrapped model to your agent:

```typescript
import { Agent } from "@mastra/core/agent";
import { withCostControl } from "agent-cost-controller/ai";
import { openai } from "@ai-sdk/openai";

const agent = new Agent({
  name: "support-bot",
  instructions: "Help customers.",
  model: withCostControl(openai("gpt-4o"), { agentId: "support-bot", accKey: "acc_…" }),
});
```

</details>

<details>
<summary><b>LangChain.js / LangGraph.js</b></summary>

`wrapModel` enforces the kill switch **and** records telemetry. (For telemetry only, add `new CostControlHandler(opts)` to any run's `callbacks`.)

```typescript
import { wrapModel } from "agent-cost-controller/langchain";
import { ChatOpenAI } from "@langchain/openai";

const model = wrapModel(new ChatOpenAI({ model: "gpt-4o" }), { agentId: "support-bot", accKey: "acc_…" });
await model.invoke("Hello"); // use anywhere, including LangGraph nodes
```

</details>

<details>
<summary><b>OpenAI Agents SDK</b></summary>

```typescript
import { wrapAgentsModel } from "agent-cost-controller/agents";
import { Agent, run, OpenAIResponsesModel } from "@openai/agents";
import OpenAI from "openai";

const model = wrapAgentsModel(new OpenAIResponsesModel(new OpenAI(), "gpt-4o"), {
  agentId: "support-bot",
  accKey: "acc_…",
});
const agent = new Agent({ name: "Support", model });
await run(agent, "Hello");
```

</details>

## ⚙️ Options

| Option          | Required | Default                                  | Description                              |
| --------------- | -------- | ---------------------------------------- | ---------------------------------------- |
| `agentId`       | yes      | —                                        | Identifies the agent for this client.    |
| `accKey`        | yes      | —                                        | Bearer token for the telemetry endpoint. |
| `endpoint`      | no       | `https://agent-cost-controller.vercel.app/v1/events` | Telemetry ingest URL.        |
| `flushInterval` | no       | `5000`                                   | Max ms before a buffered batch is sent.  |
| `batchSize`     | no       | `50`                                     | Send early once this many events queue.  |
| `killCheck`     | no       | `true`                                   | Check kill status before each call; throw `AgentKilledError` if killed. Inert until a budget + auto-stop is set in the dashboard. |
| `onKilled`      | no       | throw                                    | Run instead of throwing when a killed agent's call is blocked; its return value becomes the response (graceful containment). |
| `onError`       | no       | swallow                                  | Called on telemetry/pricing failures.    |
| `router`        | no       | off                                      | Model routing: `"auto"` (downshift cheap, tool-free calls) or a `RoutePolicy`. OpenAI adapter only. |
| `cache`         | no       | off                                      | Exact-match response cache (`{ provider: "memory" \| "upstash" \| "redis" \| "managed", … }`). OpenAI adapter only. |

## 💸 Cost reduction (routing + cache)

Two **opt-in**, zero-latency ways to spend less — both on the OpenAI adapter
(`withCostControl(client, …)`). They run *before* the call, fail open, and keep the
response shape identical.

**Model routing** — send cheap, simple calls to a cheaper model:

```ts
import { withCostControl } from "agent-cost-controller";

// "auto": tool-free calls under ~2k tokens downshift (e.g. gpt-4 → gpt-4o-mini).
const client = withCostControl(new OpenAI(), { agentId: "bot", accKey: "acc_…", router: "auto" });

// …or an explicit policy (priority-sorted; first match wins):
const client2 = withCostControl(new OpenAI(), {
  agentId: "bot",
  accKey: "acc_…",
  router: { routes: [{ name: "tiny", condition: { type: "token_estimate", max: 500 }, targetModel: "gpt-4o-mini" }] },
});
```

The model actually used is what's recorded, so cost telemetry reflects routing. A routed
call that errors automatically retries on the original model (`routing.fallback: true`). The
dashboard can also **push** a routing policy down via the status endpoint — that's how
auto-remediation's "downshift" action takes effect with no code change.

**Response cache** — replay an identical request instead of paying for it again:

```ts
const client = withCostControl(new OpenAI(), {
  agentId: "bot",
  accKey: "acc_…",
  cache: { provider: "memory" }, // or "upstash" / "redis" with { url, token? } — BYODB
});
```

Keyed on the content-free prompt fingerprint + model (one keyed read, no embedding call). A
hit skips the LLM entirely and is recorded with `cache.hit: true` and `$0` cost. **The cache
stores the raw provider response, which lives only in your store (memory / your Redis /
Upstash) — it is never sent to the telemetry endpoint.**

Prefer not to manage a store? Set `provider: "managed"` (or just flip on the cache from the
dashboard) — the SDK proxies through the hosted ACC cache using your accKey; our storage
credentials never reach your process and a per-account storage cap is enforced server-side:

```ts
const client = withCostControl(new OpenAI(), { agentId: "bot", accKey: "acc_…", cache: { provider: "managed" } });
```

**Dashboard-driven config.** The cache backend (off / built-in managed / bring-your-own-DB)
can be set per agent in the dashboard and is pushed to the SDK via the status endpoint — so
you can turn caching on, or swap your BYODB credentials, without a code change. A pushed
config takes precedence over the local `cache` option.

## 📈 Cost per successful completion

Token savings only count if reliability holds — a cheap-but-wrong answer that needs rework
isn't cheap. `reportOutcome` lets you mark how a finished workflow turned out, so the
dashboard can divide spend by *successful* completions and show failure / rework rates.

```ts
import { reportOutcome } from "agent-cost-controller";

const res = await client.chat.completions.create({ model: "gpt-4o", messages });

// Judge success however you already do (schema validated? user accepted? eval passed?):
await reportOutcome("success", { agentId: "support-bot", accKey: "acc_…" });
// …or "failure" / "rework" — plus an optional `workflow` label for by-workflow rollups.
```

**Mechanics.** It's a **standalone, stateless function**, not something hung off the wrapped
client — the wrapper must keep your framework's exact return type (so there's no per-call
handle), and the outcome is judged *after* the response anyway. So it works identically
across **every** adapter. It POSTs to a derived `…/outcomes` endpoint with your `accKey` and
**fails open** (a transport error never throws into your code). Privacy holds: only the enum
and an optional workflow **label** leave the process — never prompt or response content.

## 🦷 The chomp (budgets &amp; kill switch)

Set a **budget** or **hard call cap** on an agent in the dashboard and turn on **auto-stop**;
once spend or call count crosses the limit the backend marks the agent killed. With
`killCheck` on (the default), the SDK checks the agent's status before each call and throws
`AgentKilledError` instead of hitting the LLM — stopping a runaway loop before it spends more.
Status is cached briefly and **fails open**, so a status-endpoint outage never blocks your
calls.

<details open>
<summary><b>Catching the bite</b></summary>

```ts
import { withCostControl, AgentKilledError } from "agent-cost-controller";

const client = withCostControl(new OpenAI(), { agentId: "support-bot", accKey: "acc_…", killCheck: true });

try {
  await client.chat.completions.create({ model: "gpt-4o", messages });
} catch (err) {
  if (err instanceof AgentKilledError) {
    // agent was killed from the dashboard — stop looping
  }
}
```

</details>

Prefer graceful degradation over a thrown error? Pass `onKilled` and its return value
becomes the call's response, so one killed sub-agent doesn't crash the whole run.

## 🔬 Diagnosing token waste

Every event carries a **prompt fingerprint** — enough to deduce _why_ an agent burns
tokens, without shipping a single character of prompt content:

<details open>
<summary><b>Prompt fingerprint shape</b></summary>

```jsonc
"prompt": {
  "message_count": 14,
  "total_chars": 21840,
  "roles": {
    "system": { "count": 1, "chars": 1800 },
    "user":   { "count": 7, "chars": 9200 },
    "assistant": { "count": 6, "chars": 10840 }
  },
  "hash": "9f2c…"   // SHA-256 of the message array (one-way)
}
```

</details>

- **Prompt bloat** — `message_count` / `total_chars` climbing across calls = history re-sent and growing.
- **Loops** — the same `hash` recurring = the agent re-issuing a near-identical prompt.
- **Fat system prompt** — a large `roles.system.chars` relative to the rest.

The hash is one-way: identical prompts collide so you can correlate them, but the original text is never recoverable or transmitted.

## 🧬 How it works

Each adapter hooks its framework at the model boundary (`withCostControl()` proxies
`chat.completions.create`; the AI SDK uses `LanguageModelMiddleware`; LangChain uses a
callback handler + model wrap; the Agents SDK wraps the `Model`). All of them normalize
the finished call into one `CallRecord` and feed a single shared core: it reads the
`usage` object **after** the response returns, computes cost from a static price table,
fingerprints the prompt, and pushes the record onto an in-memory queue that flushes in
batches via `fetch`. Telemetry is fire-and-forget: it never adds latency and never throws
into your request path.

```
your code ──▶ withCostControl(client) ──▶ looks identical ──▶ create() as normal
                       │
                       └─▶ CallRecord ──▶ core ──▶ queue ──▶ fetch ──▶ dashboard
```

For a deeper walkthrough — file-by-file architecture and a step-by-step trace of a call — see [`docs/`](./docs/README.md).

## 🌳 Development

```bash
npm install
npm test          # vitest suite
npm run typecheck  # tsc --noEmit
npm run build      # tsup → dist/{index,ai,langchain,agents}.{mjs,cjs,d.ts}
```

## 📜 License

[MIT](./LICENSE) — feed it whatever you like.

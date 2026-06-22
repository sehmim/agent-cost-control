# Agent Cost Controller

Wrap your AI agents to track token usage and cost. One line, zero rewrites. Never touches your API keys, prompts, or completions — only the `usage` object. Works with **OpenAI**, the **Vercel AI SDK**, **Mastra**, **LangChain.js / LangGraph.js**, and the **OpenAI Agents SDK**.

## Install

```bash
npm install agent-cost-controller
# plus whichever framework you already use:
#   openai · ai · @langchain/core · @openai/agents
```

Requires Node 18+. Every framework is an **optional** peer dependency — install only the one you use, import from the matching subpath:

| Framework | Import | Wrapper |
| --------- | ------ | ------- |
| OpenAI | `agent-cost-controller` | `withCostControl(client, opts)` |
| Vercel AI SDK / Mastra | `agent-cost-controller/ai` | `withCostControl(model, opts)` |
| LangChain.js / LangGraph.js | `agent-cost-controller/langchain` | `wrapModel(model, opts)` / `CostControlHandler` |
| OpenAI Agents SDK | `agent-cost-controller/agents` | `wrapAgentsModel(model, opts)` |

All adapters feed the **same** privacy-safe pipeline — usage, a content-free prompt fingerprint, tool **names**, and a one-way output hash. Raw prompts, completions, and keys never leave the process, and telemetry is recorded after the call so it never adds latency.

## Usage

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

Streaming works too — `agent-cost-controller` auto-requests usage stats and reads them off the final chunk:

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

## Other frameworks

The same `agentId` / `accKey` / kill-switch options apply to every adapter below.

### Vercel AI SDK

Wrap any model and hand it to `generateText` / `streamText`:

```typescript
import { withCostControl } from "agent-cost-controller/ai";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

const model = withCostControl(openai("gpt-4o"), { agentId: "support-bot", accKey: "acc_…" });
await generateText({ model, prompt: "Hello" });
```

### Mastra

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

### LangChain.js / LangGraph.js

`wrapModel` enforces the kill switch **and** records telemetry. (For telemetry only, add `new CostControlHandler(opts)` to any run's `callbacks`.)

```typescript
import { wrapModel } from "agent-cost-controller/langchain";
import { ChatOpenAI } from "@langchain/openai";

const model = wrapModel(new ChatOpenAI({ model: "gpt-4o" }), { agentId: "support-bot", accKey: "acc_…" });
await model.invoke("Hello"); // use anywhere, including LangGraph nodes
```

### OpenAI Agents SDK

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

## Options

| Option          | Required | Default                                  | Description                              |
| --------------- | -------- | ---------------------------------------- | ---------------------------------------- |
| `agentId`       | yes      | —                                        | Identifies the agent for this client.    |
| `accKey`     | yes      | —                                        | Bearer token for the telemetry endpoint. |
| `endpoint`      | no       | `https://agent-cost-controller.vercel.app/v1/events`  | Telemetry ingest URL.                    |
| `flushInterval` | no       | `5000`                                   | Max ms before a buffered batch is sent.  |
| `batchSize`     | no       | `50`                                     | Send early once this many events queue.  |
| `killCheck`     | no       | `true`                                   | Check kill status before each call; throw `AgentKilledError` if killed. Inert until a budget + auto-stop is set in the dashboard. |
| `onKilled`      | no       | throw                                    | Run instead of throwing when a killed agent's call is blocked; its return value becomes the response (graceful containment). |
| `onError`       | no       | swallow                                  | Called on telemetry/pricing failures.    |

## Kill switch

Set `killCheck: true` to let the dashboard stop a runaway agent. Before each call the SDK
checks the agent's status; if it's been killed, the call throws `AgentKilledError` instead
of hitting the LLM. Status is cached briefly and **fails open** — a status-endpoint outage
never blocks your calls.

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

## Diagnosing token waste

Every event carries a **prompt fingerprint** — enough to deduce *why* an agent burns tokens, without shipping a single character of prompt content:

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

- **Prompt bloat** — `message_count` / `total_chars` climbing across an agent's calls = history re-sent and growing.
- **Loops** — the same `hash` recurring = the agent re-issuing a near-identical prompt.
- **Fat system prompt** — a large `roles.system.chars` relative to the rest.

The hash is one-way: identical prompts collide so you can correlate them, but the original text is never recoverable or transmitted.

## How it works

Each adapter hooks its framework at the model boundary (`withCostControl()` proxies `chat.completions.create`; the AI SDK uses `LanguageModelMiddleware`; LangChain uses a callback handler + model wrap; the Agents SDK wraps the `Model`). All of them normalize the finished call into one `CallRecord` and feed a single shared core: it reads the `usage` object **after** the response returns, computes cost from a static price table, fingerprints the prompt, and pushes the record onto an in-memory queue that flushes in batches via `fetch`. Telemetry is fire-and-forget: it never adds latency and never throws into your request path.

For a deeper walkthrough — file-by-file architecture and a step-by-step trace of a call — see [`docs/`](./docs/README.md).

## License

MIT

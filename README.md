# AgentHelm

Wrap your OpenAI client to track token usage and cost. One line, zero SDK rewrites. Never touches your API keys, prompts, or completions — only the `usage` object.

## Install

```bash
npm install agenthelm openai
```

Requires Node 18+. `openai` is a peer dependency — bring your own version.

## Usage

```typescript
import { monitor } from "agenthelm";
import OpenAI from "openai";

const client = monitor(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), {
  agentId: "support-bot",
  helmKey: "ahk_abc123",
});

// Everything else is unchanged — same methods, same types, same return values.
const res = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
});
```

Streaming works too — `agenthelm` auto-requests usage stats and reads them off the final chunk:

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

## Options

| Option          | Required | Default                                  | Description                              |
| --------------- | -------- | ---------------------------------------- | ---------------------------------------- |
| `agentId`       | yes      | —                                        | Identifies the agent for this client.    |
| `helmKey`     | yes      | —                                        | Bearer token for the telemetry endpoint. |
| `endpoint`      | no       | `https://api.agenthelm.dev/v1/events`  | Telemetry ingest URL.                    |
| `flushInterval` | no       | `5000`                                   | Max ms before a buffered batch is sent.  |
| `batchSize`     | no       | `50`                                     | Send early once this many events queue.  |
| `killCheck`     | no       | `false`                                  | Check kill status before each call; throw `AgentKilledError` if killed. |
| `onError`       | no       | swallow                                  | Called on telemetry/pricing failures.    |

## Kill switch

Set `killCheck: true` to let the dashboard stop a runaway agent. Before each call the SDK
checks the agent's status; if it's been killed, the call throws `AgentKilledError` instead
of hitting the LLM. Status is cached briefly and **fails open** — a status-endpoint outage
never blocks your calls.

```ts
import { monitor, AgentKilledError } from "agenthelm";

const client = monitor(new OpenAI(), { agentId: "support-bot", helmKey: "ahk_…", killCheck: true });

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

`monitor()` returns a Proxy over your client. It intercepts only `chat.completions.create`, reads the `usage` object **after** the response returns, computes cost from a static price table, fingerprints the prompt, and pushes the record onto an in-memory queue that flushes in batches via `fetch`. Telemetry is fire-and-forget: it never adds latency and never throws into your request path.

For a deeper walkthrough — file-by-file architecture and a step-by-step trace of a call — see [`docs/`](./docs/README.md).

## License

MIT

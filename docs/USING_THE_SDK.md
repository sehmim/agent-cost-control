# Using the AgentHelm SDK in another project

The SDK isn't published to npm yet, so you consume it locally. Once your backend
is running (see `frontend/SUPABASE_SETUP.md`), point the SDK at it.

## 1. Link the SDK locally

From this `sdk/` directory:

```bash
cd sdk
npm install
npm run build      # produces dist/
npm link           # registers "agenthelm" globally on your machine
```

In the project that runs your agents:

```bash
cd ../your-agent-project
npm link agenthelm
npm install openai   # peer dependency — bring your own version
```

> Alternative without `npm link`: install straight from the folder —
> `npm install /absolute/path/to/agent-helm/sdk` — or from a git URL once pushed.

## 2. Wrap your client

```ts
import { monitor, AgentKilledError } from "agenthelm";
import OpenAI from "openai";

const client = monitor(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), {
  agentId: "orchestrator-planner",          // a stable name per agent
  helmKey: process.env.AGENTHELM_KEY!,       // the key you minted (api_keys table)
  endpoint: process.env.AGENTHELM_ENDPOINT,  // see step 3
  // killCheck defaults to true — leave it on. It's inert until you set a budget
  // + auto-stop on the agent, so it costs nothing until you actually use it.
});

// Use it exactly like the OpenAI client — same methods, types, return values.
const res = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
});
```

## 3. Point it at your backend

`endpoint` is the public ingest path, `<base>/v1/events`:

| Where the backend runs | `endpoint` value |
| --- | --- |
| Local dev (`npm run dev`) | `http://localhost:3000/v1/events` |
| Deployed (e.g. Vercel) | `https://your-app.vercel.app/v1/events` |

The status endpoint for kill/auto-stop is derived automatically
(`<base>/v1/agents/<id>/status`) — you don't configure it separately.

> If you omit `endpoint`, the SDK defaults to `https://api.agenthelm.dev/v1/events`,
> which isn't a real service. Until you own that domain, always set `endpoint`.

## 4. Multiple agents in one orchestration

Give each agent its own `agentId` so spend, loops, and bloat are attributed
correctly. Reuse the same `helmKey`:

```ts
const planner    = monitor(new OpenAI(), { agentId: "planner",    helmKey, endpoint });
const researcher = monitor(new OpenAI(), { agentId: "researcher", helmKey, endpoint });
const writer     = monitor(new OpenAI(), { agentId: "writer",     helmKey, endpoint });
```

Each shows up as a separate row on the dashboard with its own budget and alerts.

## 5. Handle a kill (without taking down the host)

A killed agent (manually, or auto-stopped at budget) blocks the call *before* it
hits OpenAI. The kill is **scoped to that one agent's client** — killing the
planner never affects the writer. You choose how a block surfaces:

**Default — throw `AgentKilledError`.** Good for a single loop you control:

```ts
try {
  await client.chat.completions.create({ model: "gpt-4o", messages });
} catch (err) {
  if (err instanceof AgentKilledError) {
    console.warn("Agent killed — stopping.");
    return; // exit the loop instead of retrying
  }
  throw err;
}
```

**Graceful — `onKilled` returns a fallback (no throw).** Use this in
multi-agent orchestration so a killed *sub*agent degrades instead of throwing an
error that could crash the whole service:

```ts
const researcher = monitor(new OpenAI(), {
  agentId: "researcher",
  helmKey,
  endpoint,
  onKilled: ({ agentId }) => {
    log.warn(`${agentId} killed — skipping its step`);
    return null; // becomes the call's return value; caller handles null
  },
});

const res = await researcher.chat.completions.create({ model: "gpt-4o", messages });
if (res === null) { /* subagent was killed — route around it */ }
```

Either way, no LLM call is made and no spend occurs.

## Behavior notes

- **No added latency.** Telemetry is recorded after the response and shipped in
  background batches. A telemetry/network failure never throws into your call.
- **Kill propagation is up to ~10s.** Status is cached (`KILL_CACHE_MS`), so a
  killed agent may complete a few in-flight calls before stopping. It's a safety
  cap, not a hard real-time ceiling. Lower `flushInterval`/`batchSize` for tighter
  loops while testing.
- **Only `chat.completions.create` is intercepted.** Other client methods pass
  through untouched.
- **Never sends prompt content** — only token counts, cost, and a one-way prompt
  fingerprint (sizes + hash).

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Agent never appears on dashboard | `endpoint` wrong, or `helmKey` not in `api_keys` |
| 401 from ingest | `helmKey` doesn't match a row in `api_keys` |
| Kill button doesn't stop the agent | no budget/auto-stop set, or `killCheck: false` was passed |
| A killed subagent crashes the whole run | add an `onKilled` handler so it returns a fallback instead of throwing |
| `Cannot find module 'agenthelm'` | re-run `npm link agenthelm`; ensure `npm run build` ran |
| Redirected to /login when posting | backend older than this fix — `/v1/*` must be excluded from auth middleware |

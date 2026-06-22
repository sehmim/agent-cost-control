# Dataflow

Follow one `create()` call from start to finish. This is the part that's hardest to see
from the code alone, because a `Proxy` makes the indirection invisible at the call site.

## Setup (happens once)

```ts
const client = withCostControl(new OpenAI({ apiKey }), { agentId: "support-bot", accKey: "acc_…" });
```

1. `withCostControl()` checks `agentId` + `accKey` exist and the client looks like OpenAI.
2. It builds `ResolvedOptions` — your options with defaults filled in from `consts.ts`.
3. It creates **one** `TelemetryQueue` for this client.
4. `keepAlive(queue)` registers a `beforeExit` flush (only the first call installs it).
5. `intercept(client, queue, opts)` returns a proxied client. **You hold the proxy now.**

Nothing has been sent anywhere. No timer is running yet.

## What the proxy actually is

`intercept` stacks three one-level proxies via `swap()`:

```
client (proxy)
  └─ .chat (proxy)
       └─ .completions (proxy)
            └─ .create  ← replaced with traceCreate
            └─ everything else passes through, bound to the real object
```

Reading `client.apiKey`, `client.models`, etc. returns the real thing untouched. Only
the `create` function is swapped. That's the entire trick.

## A non-streaming call

```ts
const res = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
});
```

```
create() called
   │
   ▼
traceCreate(realCreate, args, queue, opts)
   │  1. read model from params
   │  2. prompt = fingerprintMessages(params.messages)   ← sizes + hash, no content
   │  3. start = Date.now()
   │
   ▼
realCreate(...args)            ← the actual OpenAI HTTP request, untouched
   │
   ▼ (resolves)
response { …, usage: { prompt_tokens, completion_tokens } }
   │
   ├─ emit(ctx, stream=false, input=usage.prompt_tokens, output=usage.completion_tokens)
   │     │
   │     ├─ cost = calculateCost(model, input, output)   ← PRICING lookup
   │     └─ queue.push({ agent_id, model, tokens, cost, latency, timestamp, stream, prompt })
   │
   ▼
return response   ← caller gets the original object, unchanged
```

Key point: `emit()` runs **after** the response resolves, and what's returned is the
exact original `response`. The recording is a side effect on the way out.

## A streaming call

```ts
const stream = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
});
for await (const chunk of stream) { /* … */ }
```

Streaming has one wrinkle: OpenAI only puts `usage` on the final chunk **if you ask for
it**. So `traceCreate` injects that request for you.

```
create() called with stream: true
   │
   ▼
traceCreate
   │  if params.stream_options.include_usage !== true:
   │     args[0] = { ...params, stream_options: { include_usage: true } }   ← auto-injected
   │
   ▼
realCreate(...args)  → returns an async iterable of chunks
   │
   ▼
traceStream(stream, ctx)         ← an async generator wrapping the real one
   │
   │   for await (chunk of realStream):
   │       if chunk.usage: remember input/output token counts
   │       yield chunk            ← passed through untouched, in real time
   │
   │   (loop ends / finally)
   └─ emit(ctx, stream=true, input, output)  → queue.push(...)
```

Your `for await` sees every chunk exactly as OpenAI sent it, with no added latency. The
recording happens in the generator's `finally`, after the last chunk.

## From queue to network

`queue.push(event)` doesn't necessarily send anything yet:

```
push(event)
   │
   ├─ buffer.length >= batchSize ?  ── yes ──▶ flush()  (send now)
   │
   └─ no ──▶ ensure a setInterval is running ──▶ flush() every flushInterval ms
```

`flush()`:

```
flush()
   │  take all buffered events, clear the buffer
   ▼
POST endpoint
   headers: Authorization: Bearer <accKey>, Content-Type: application/json
   body:    { events: [...] }
   │
   ├─ ok      → done
   └─ error / non-2xx → onError(err)     ← never thrown into your code
```

On process exit, the `beforeExit` hook flushes whatever is still buffered so the last
few events aren't lost.

## The whole picture

```
┌─ your app ────────────────────────────────────────────────┐
│  client.chat.completions.create(params)                    │
│        │                                                   │
│   [ proxy: traceCreate ]                                   │
│        │ fingerprint prompt, start timer                   │
│        ▼                                                   │
│   real OpenAI create()  ──HTTP──▶  OpenAI   (unchanged)    │
│        │ response / stream                                 │
│        ▼                                                   │
│   emit() → TelemetryEvent → queue.push()                  │
│        │                                                   │
│   [ TelemetryQueue ]  batch by size or timer               │
│        │ fire-and-forget                                   │
└────────┼───────────────────────────────────────────────────┘
         ▼
   POST https://agent-cost-controller.vercel.app/v1/events   (Bearer accKey)
```

Everything to the left of the HTTP arrow is synchronous with your call only up to
"start the real request." The token accounting and network send happen on the way back
and in the background — your latency is just the real OpenAI call.

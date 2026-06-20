# Architecture

Seven files under `src/`. Each owns one concern. Nothing is bundled — `openai` is a
peer dependency, and `fetch`/`crypto` are Node built-ins.

```
src/
├── index.ts        public exports (the package's surface)
├── monitor.ts      entry point + the OpenAI interceptor  ← the heart
├── telemetry.ts    the batched, fire-and-forget event queue
├── fingerprint.ts  turn a prompt into a content-free summary
├── pricing.ts      turn token counts into a USD cost
├── consts.ts       every tunable constant + the price table
└── types.ts        shared interfaces, no logic
```

## How they depend on each other

```
            index.ts
               │ re-exports
               ▼
           monitor.ts ──────────────┐
            │   │   │                │
            ▼   ▼   ▼                ▼
   telemetry  pricing  fingerprint  consts
       │         │                    ▲
       └─────────┴────────────────────┘  (pricing & monitor read consts)

   types.ts  ← imported by everyone for shapes (no runtime code)
```

`monitor.ts` is the only file that knows about OpenAI's API shape. Everything else is
provider-agnostic, which is what keeps a future `anthropic` path cheap.

## File-by-file

### `monitor.ts` — the heart

This is the whole entry path. Worth reading top to bottom. Key pieces:

- **`monitor(client, options)`** — validates that `agentId` + `helmKey` are present,
  confirms the client looks like an OpenAI client, fills in defaults from `consts`,
  creates one `TelemetryQueue`, and returns the intercepted client.
- **`intercept()`** — wraps the client so only `chat.completions.create` is replaced.
  It proxies three levels deep: `client → chat → completions`.
- **`swap(obj, key, replace)`** — the small reusable helper that does one level of
  proxying: "return a replacement for `key`, pass everything else straight through
  (methods stay bound so `this` still works)." `intercept` calls it three times.
- **`traceCreate()`** — the wrapper that actually runs around your `create()` call:
  fingerprint the prompt, start a timer, call the real method, then record usage.
  Splits into the streaming vs non-streaming paths.
- **`traceStream()`** — an async generator that re-yields every chunk untouched and
  grabs `usage` off whichever chunk carries it, recording once the stream ends.
- **`emit()`** — assembles a `TelemetryEvent` and pushes it onto the queue.
- **`keepAlive()`** — registers a one-time `beforeExit` flush so buffered events aren't
  lost when the process ends.

> Why a `Proxy` instead of just reassigning `client.chat.completions.create`?
> A Proxy keeps the original object untouched and preserves the exact TypeScript
> types, so the returned client is a true drop-in. We never mutate what you passed in.

### `telemetry.ts` — `TelemetryQueue`

An in-memory buffer with two triggers to flush:
- **size** — once `batchSize` events are buffered, flush immediately;
- **time** — otherwise a `setInterval` flushes every `flushInterval` ms.

`flush()` POSTs `{ events }` with a `Bearer ${helmKey}` header via `fetch`. Any failure
(network error or non-2xx) is handed to `onError` and never thrown. The timer is
`unref`'d so it never keeps the Node process alive on its own.

### `fingerprint.ts` — `fingerprintMessages(messages)`

Turns the request's `messages` array into a `PromptFingerprint`: message count, total
chars, a per-role `{count, chars}` breakdown, and a **SHA-256 hash** of the message
array. The hash is one-way — identical prompts produce the same hash (so you can spot
loops), but the original text can't be recovered. Returns `undefined` if `messages`
isn't an array. **No raw content leaves this function.**

### `pricing.ts` — `calculateCost(model, input, output, onError?)`

Looks the model up in the `PRICING` table and multiplies. Unknown model → returns `0`
and warns (via `onError` or `console`), never throws — a missing price must not break
the wrapped call.

### `consts.ts`

Every tunable in one place: `SDK_VERSION`, `DEFAULT_ENDPOINT`, `DEFAULT_FLUSH_INTERVAL`,
`DEFAULT_BATCH_SIZE`, and the `PRICING` table (built from per-1M list prices via a small
`rate()` helper).

### `types.ts`

Pure interfaces, no runtime code: `MonitorOptions` (what the caller passes),
`ResolvedOptions` (defaults filled in, used internally), `TelemetryEvent` (what gets
shipped), `PromptFingerprint`, and `ModelRate`.

### `index.ts`

The public surface. Exports `monitor`, plus `calculateCost`, `fingerprintMessages`, and
`PRICING` for callers who want them, and the types.

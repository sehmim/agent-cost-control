# Agent Cost Controller SDK — Docs

Start here if the codebase feels opaque.

## The one-paragraph mental model

You hand `monitor()` your OpenAI client. It gives you back a **look-alike** client
(a `Proxy`) that behaves exactly the same — except every time you call
`chat.completions.create`, it quietly reads the token `usage` off the response,
works out the cost, summarizes the prompt's *shape* (never its content), and drops
a small record into an in-memory queue. That queue ships records to your telemetry
endpoint in batches, in the background. Your call is never slowed down or changed.

```
your code → monitor(client) → looks identical → you call create() as normal
                                   │
                                   └─ after each call: usage + cost + prompt shape → queue → HTTP
```

## Read in this order

1. **[architecture.md](./architecture.md)** — what each file does and why there are seven of them.
2. **[dataflow.md](./dataflow.md)** — follow a single `create()` call all the way through, step by step (streaming and non-streaming).

## The two rules that explain most decisions

- **Never touch the caller's path.** Recording happens *after* the response, errors are
  swallowed to `onError`, HTTP is fire-and-forget. The wrapped call must be
  indistinguishable from the unwrapped one.
- **Never transmit raw content.** Only the `usage` numbers and a content-free
  `PromptFingerprint` (sizes + a one-way hash) ever leave the machine.

import type { ResolvedOptions, TelemetryEvent } from "./types.js";

/**
 * Buffers telemetry events and ships them to the ingest endpoint in batches.
 * Fire-and-forget: dispatch errors are routed to onError, never thrown into the
 * caller's request path.
 */
export class TelemetryQueue {
  private buffer: TelemetryEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: ResolvedOptions) {}

  push(event: TelemetryEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.opts.batchSize) {
      void this.flush();
    } else {
      this.ensureTimer();
    }
  }

  /** Send everything currently buffered. Safe to call manually or on shutdown. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];

    try {
      const res = await fetch(this.opts.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.helmKey}`,
        },
        body: JSON.stringify({ events }),
      });
      if (!res.ok) {
        this.opts.onError(new Error(`agenthelm: telemetry POST failed with ${res.status}`));
      }
    } catch (err) {
      this.opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Stop the flush timer. Call once the queue is no longer needed. */
  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.opts.flushInterval);
    // Don't keep the process alive just for telemetry.
    this.timer.unref?.();
  }
}

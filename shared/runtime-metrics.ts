const SAMPLE_CAP = 20_000;
const BUCKET_RETENTION_SECONDS = 900;

const KNOWN_ROUTES = new Set([
  "GET /health",
  "GET /messages-since-id",
  "POST /register",
  "POST /register-cli",
  "POST /poll-by-pid",
  "POST /claim-by-pid",
  "POST /ack-by-pid",
  "POST /hook-heartbeat-by-pid",
  "POST /heartbeat",
  "POST /metrics",
  "POST /set-summary",
  "POST /set-name",
  "POST /list-peers",
  "POST /send-message",
  "POST /send-to-peer",
  "POST /broadcast-message",
  "POST /message-status",
  "POST /lifecycle-identity",
  "POST /poll-messages",
  "POST /ack-messages",
  "POST /unregister",
]);

export interface LatencySummary {
  count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
}

export interface RuntimeMetricsSnapshot {
  metrics_version: 1;
  enabled: boolean;
  started_at: string;
  route_totals: Record<string, number>;
  route_buckets: Array<{ epoch_second: number; total: number; routes: Record<string, number> }>;
  queue_to_buffer: LatencySummary;
  queue_to_ack: LatencySummary;
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function summarizeLatency(samples: number[]): LatencySummary {
  if (samples.length === 0) return { count: 0, p50_ms: null, p95_ms: null, max_ms: null };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50_ms: percentile(sorted, 0.5),
    p95_ms: percentile(sorted, 0.95),
    max_ms: sorted.at(-1)!,
  };
}

class NumberRing {
  private readonly samples = new Array<number>(SAMPLE_CAP);
  private size = 0;
  private next = 0;

  push(value: number): void {
    this.samples[this.next] = Math.max(0, Math.round(value));
    this.next = (this.next + 1) % SAMPLE_CAP;
    this.size = Math.min(this.size + 1, SAMPLE_CAP);
  }

  values(): number[] {
    if (this.size < SAMPLE_CAP) return this.samples.slice(0, this.size);
    return [...this.samples.slice(this.next), ...this.samples.slice(0, this.next)];
  }
}

function canonicalRoute(method: string, path: string): string {
  const normalizedMethod = method.toUpperCase();
  const candidate = `${normalizedMethod} ${path}`;
  if (KNOWN_ROUTES.has(candidate)) return candidate;
  if (normalizedMethod === "GET" || normalizedMethod === "POST") return `${normalizedMethod} /unknown`;
  return "OTHER /unknown";
}

export class RuntimeMetrics {
  readonly enabled: boolean;
  private readonly startedAt: string;
  private readonly routeTotals: Record<string, number> = Object.create(null) as Record<string, number>;
  private readonly routeBuckets = new Map<number, Record<string, number>>();
  private lastPruneSecond = 0;
  private readonly bufferedIds = new Set<number>();
  private readonly bufferOrder = new Array<number>(SAMPLE_CAP);
  private bufferOrderSize = 0;
  private bufferOrderNext = 0;
  private readonly queueToBuffer = new NumberRing();
  private readonly queueToAck = new NumberRing();

  constructor(enabled: boolean, now = Date.now()) {
    this.enabled = enabled;
    this.startedAt = new Date(now).toISOString();
  }

  recordRoute(method: string, path: string, now = Date.now()): void {
    if (!this.enabled) return;
    const route = canonicalRoute(method, path);
    this.routeTotals[route] = (this.routeTotals[route] ?? 0) + 1;
    const second = Math.floor(now / 1_000);
    let bucket = this.routeBuckets.get(second);
    if (!bucket) {
      bucket = Object.create(null) as Record<string, number>;
      this.routeBuckets.set(second, bucket);
    }
    bucket[route] = (bucket[route] ?? 0) + 1;
    if (second - this.lastPruneSecond >= 60) {
      this.lastPruneSecond = second;
      const cutoff = second - BUCKET_RETENTION_SECONDS;
      for (const key of this.routeBuckets.keys()) {
        if (key >= cutoff) break;
        this.routeBuckets.delete(key);
      }
    }
  }

  recordQueueToBuffer(messageId: number, sentAt: string, now = Date.now()): void {
    if (!this.enabled || this.bufferedIds.has(messageId)) return;
    const sent = Date.parse(sentAt);
    if (!Number.isFinite(sent)) return;
    this.bufferedIds.add(messageId);
    if (this.bufferOrderSize === SAMPLE_CAP) {
      this.bufferedIds.delete(this.bufferOrder[this.bufferOrderNext]!);
    } else {
      this.bufferOrderSize++;
    }
    this.bufferOrder[this.bufferOrderNext] = messageId;
    this.bufferOrderNext = (this.bufferOrderNext + 1) % SAMPLE_CAP;
    this.queueToBuffer.push(now - sent);
  }

  recordQueueToAck(sentAt: string, now = Date.now()): void {
    if (!this.enabled) return;
    const sent = Date.parse(sentAt);
    if (Number.isFinite(sent)) this.queueToAck.push(now - sent);
  }

  snapshot(): RuntimeMetricsSnapshot {
    const routeTotals = Object.fromEntries(Object.entries(this.routeTotals).sort(([a], [b]) => a.localeCompare(b)));
    const routeBuckets = [...this.routeBuckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([epochSecond, routes]) => {
        const ordered = Object.fromEntries(Object.entries(routes).sort(([a], [b]) => a.localeCompare(b)));
        return { epoch_second: epochSecond, total: Object.values(routes).reduce((sum, value) => sum + value, 0), routes: ordered };
      });
    return {
      metrics_version: 1,
      enabled: this.enabled,
      started_at: this.startedAt,
      route_totals: routeTotals,
      route_buckets: routeBuckets,
      queue_to_buffer: summarizeLatency(this.queueToBuffer.values()),
      queue_to_ack: summarizeLatency(this.queueToAck.values()),
    };
  }
}

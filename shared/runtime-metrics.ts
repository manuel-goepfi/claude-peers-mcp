const SAMPLE_CAP = 20_000;
const BUCKET_RETENTION_SECONDS = 900;

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

function summarize(samples: number[]): LatencySummary {
  if (samples.length === 0) return { count: 0, p50_ms: null, p95_ms: null, max_ms: null };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50_ms: percentile(sorted, 0.5),
    p95_ms: percentile(sorted, 0.95),
    max_ms: sorted.at(-1)!,
  };
}

function pushBounded(target: number[], value: number): void {
  target.push(Math.max(0, Math.round(value)));
  if (target.length > SAMPLE_CAP) target.splice(0, target.length - SAMPLE_CAP);
}

export class RuntimeMetrics {
  readonly enabled: boolean;
  private readonly startedAt: string;
  private readonly routeTotals: Record<string, number> = Object.create(null) as Record<string, number>;
  private readonly routeBuckets = new Map<number, Record<string, number>>();
  private readonly postRouteCache = new Map<string, string>();
  private readonly otherRouteCache = new Map<string, string>();
  private lastPruneSecond = 0;
  private readonly bufferedIds = new Set<number>();
  private readonly bufferOrder: number[] = [];
  private readonly queueToBuffer: number[] = [];
  private readonly queueToAck: number[] = [];

  constructor(enabled: boolean, now = Date.now()) {
    this.enabled = enabled;
    this.startedAt = new Date(now).toISOString();
  }

  recordRoute(method: string, path: string, now = Date.now()): void {
    if (!this.enabled) return;
    const cache = method === "POST" ? this.postRouteCache : this.otherRouteCache;
    let route = cache.get(path);
    if (!route) {
      route = `${method.toUpperCase()} ${path}`;
      cache.set(path, route);
    }
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
    this.bufferOrder.push(messageId);
    if (this.bufferOrder.length > SAMPLE_CAP) {
      const removed = this.bufferOrder.splice(0, this.bufferOrder.length - SAMPLE_CAP);
      for (const id of removed) this.bufferedIds.delete(id);
    }
    pushBounded(this.queueToBuffer, now - sent);
  }

  recordQueueToAck(sentAt: string, now = Date.now()): void {
    if (!this.enabled) return;
    const sent = Date.parse(sentAt);
    if (Number.isFinite(sent)) pushBounded(this.queueToAck, now - sent);
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
      queue_to_buffer: summarize(this.queueToBuffer),
      queue_to_ack: summarize(this.queueToAck),
    };
  }
}

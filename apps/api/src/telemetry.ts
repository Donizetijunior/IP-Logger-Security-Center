import type { Pool } from '@ipl/database';

/**
 * Telemetria operacional sem PII. Contadores ficam em memória e são gravados em
 * telemetry_counters (por minuto) quando o banco estiver disponível; assim falhas de
 * captura durante uma queda do PostgreSQL continuam visíveis depois da recuperação (CA-05).
 */
export class Telemetry {
  readonly totals = new Map<string, number>();
  private pending = new Map<string, number>();
  private latencies: number[] = [];
  private readonly maxSamples = 5000;
  private timer: NodeJS.Timeout | null = null;

  increment(key: string, by = 1): void {
    this.totals.set(key, (this.totals.get(key) ?? 0) + by);
    const bucket = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
    const k = `${key}|${bucket}`;
    this.pending.set(k, (this.pending.get(k) ?? 0) + by);
  }

  observeRedirectMs(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > this.maxSamples) this.latencies.shift();
  }

  percentiles(): { p50: number; p95: number; p99: number; samples: number } {
    if (this.latencies.length === 0) return { p50: 0, p95: 0, p99: 0, samples: 0 };
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99), samples: sorted.length };
  }

  async flush(pool: Pool): Promise<void> {
    if (this.pending.size === 0) return;
    const snapshot = this.pending;
    this.pending = new Map();
    try {
      for (const [k, v] of snapshot) {
        const [key, bucket] = k.split('|') as [string, string];
        await pool.query(
          `INSERT INTO telemetry_counters (key, bucket, value) VALUES ($1, $2, $3)
           ON CONFLICT (key, bucket) DO UPDATE SET value = telemetry_counters.value + EXCLUDED.value`,
          [key, bucket, v],
        );
      }
    } catch {
      // banco indisponível: devolve ao buffer para nova tentativa
      for (const [k, v] of snapshot) this.pending.set(k, (this.pending.get(k) ?? 0) + v);
    }
  }

  start(pool: Pool, everyMs = 15_000): void {
    this.timer = setInterval(() => void this.flush(pool), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  prometheus(): string {
    const lines: string[] = [];
    for (const [k, v] of this.totals) lines.push(`iplogger_${k.replace(/[^a-z0-9_]/gi, '_')}_total ${v}`);
    const p = this.percentiles();
    lines.push(`iplogger_redirect_ms{quantile="0.5"} ${p.p50.toFixed(2)}`);
    lines.push(`iplogger_redirect_ms{quantile="0.95"} ${p.p95.toFixed(2)}`);
    lines.push(`iplogger_redirect_ms{quantile="0.99"} ${p.p99.toFixed(2)}`);
    return `${lines.join('\n')}\n`;
  }
}

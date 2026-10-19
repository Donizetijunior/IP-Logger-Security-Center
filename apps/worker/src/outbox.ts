import type { Pool } from '@ipl/database';

export interface JobSink {
  add(name: string, data: { eventId: string }, opts: { jobId: string }): Promise<unknown>;
}

/**
 * Publica itens da outbox no BullMQ. At-least-once e idempotente (jobId = id da outbox).
 * Se o Redis estiver offline, o add falha, a transação reverte e os itens ficam pendentes (CA-04).
 */
export async function publishOutbox(pool: Pool, sink: JobSink, batchSize = 200): Promise<{ published: number; failed: boolean }> {
  const client = await pool.connect();
  let published = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; aggregate_id: string }>(
      `SELECT id, aggregate_id FROM outbox_events WHERE published_at IS NULL ORDER BY created_at
       LIMIT $1 FOR UPDATE SKIP LOCKED`, [batchSize],
    );
    const done: string[] = [];
    for (const row of rows) {
      try {
        await sink.add('enrich', { eventId: row.aggregate_id }, { jobId: row.id });
        done.push(row.id);
      } catch {
        await client.query('COMMIT');
        // marca o que foi publicado antes da falha e registra tentativa nos demais
        await pool.query('UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::uuid[])', [done]);
        await pool.query('UPDATE outbox_events SET attempts = attempts + 1 WHERE published_at IS NULL AND id = $1', [row.id]);
        return { published: done.length, failed: true };
      }
    }
    if (done.length) await client.query('UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::uuid[])', [done]);
    await client.query('COMMIT');
    published = done.length;
    return { published, failed: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Reenfileira eventos "partial" recentes para nova tentativa quando os provedores voltarem. */
export async function requeuePartial(pool: Pool, windowHours = 24, limit = 200): Promise<number> {
  const { rowCount } = await pool.query(
    `INSERT INTO outbox_events (aggregate_id, type)
     SELECT e.id, 'access_event.enrich' FROM access_events e
     WHERE e.enrichment_status = 'partial' AND e.occurred_at > now() - ($1 || ' hours')::interval
       AND e.enriched_at < now() - interval '10 minutes'
       AND NOT EXISTS (SELECT 1 FROM outbox_events o WHERE o.aggregate_id = e.id AND o.published_at IS NULL)
     LIMIT $2`,
    [String(windowHours), limit],
  );
  return rowCount ?? 0;
}

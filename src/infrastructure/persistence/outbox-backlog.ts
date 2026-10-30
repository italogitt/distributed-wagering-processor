import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxBacklog } from '../metrics/metrics';

// Usa o índice parcial outbox_events_pending_next_attempt_idx (published_at is null).
const BACKLOG_SQL = `
  select count(*)::int as pending,
         coalesce(extract(epoch from now() - min(created_at)), 0)::float8 as oldest_age_seconds
  from outbox_events
  where published_at is null`;

/** Leitura para os gauges da outbox, fora de qualquer transação de negócio. */
export async function readOutboxBacklog(em: EntityManager): Promise<OutboxBacklog> {
  const [row] = await em.fork().execute(BACKLOG_SQL);
  return { pending: row?.pending ?? 0, oldestAgeSeconds: Math.max(0, row?.oldest_age_seconds ?? 0) };
}

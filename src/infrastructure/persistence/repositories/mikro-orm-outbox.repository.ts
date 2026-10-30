import type { EntityManager } from '@mikro-orm/postgresql';
import type { IntegrationEvent } from '../../../application/events';
import type { OutboxRepository, PendingOutboxEvent } from '../../../application/ports/outbox.repository';
import { OutboxEventRecord } from '../entities/outbox-event.record';

// D18 + D19. O NOT EXISTS segura um evento enquanto houver outro mais antigo
// do mesmo aggregate pendente (mesmo que em backoff), então um lote tem no
// máximo um evento por aggregate. `for update of o skip locked`: trava só as
// linhas escolhidas e pula as que outro publisher já travou. Se outro
// publisher publicou a linha entre o snapshot e o lock, o Postgres reavalia
// `published_at is null` na versão nova e a linha sai do resultado.
const CLAIM_SQL = `
  select o.id, o.event_type, o.aggregate_id, o.attempts, o.payload
  from outbox_events o
  where o.published_at is null
    and o.next_attempt_at <= now()
    and not exists (
      select 1 from outbox_events older
      where older.aggregate_id = o.aggregate_id
        and older.published_at is null
        and older.sequence < o.sequence
    )
  order by o.sequence
  limit ?
  for update of o skip locked`;

// clock_timestamp(), não now(): now() é o início da transação, e o lote pode
// ter passado segundos esperando o SQS. Com now(), o backoff já nasceria vencido.
const SCHEDULE_RETRY_SQL = `
  update outbox_events
  set attempts = ?, next_attempt_at = clock_timestamp() + make_interval(secs => ?), last_error = ?
  where id = ?`;

interface ClaimedRow {
  id: string;
  event_type: string;
  aggregate_id: string;
  attempts: number;
  payload: Record<string, unknown>;
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(events: readonly IntegrationEvent<unknown>[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    // `sequence` fica de fora: o bigserial do banco define a ordem de inserção.
    await this.em.insertMany(
      OutboxEventRecord,
      events.map((event) => ({
        id: event.eventId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: { ...event.toJSON() },
        createdAt: event.occurredAt,
        publishedAt: null,
        attempts: 0,
        nextAttemptAt: event.occurredAt,
        lastError: null,
      })),
    );
  }

  async claimPending(limit: number): Promise<PendingOutboxEvent[]> {
    const rows: ClaimedRow[] = await this.em.execute(CLAIM_SQL, [limit]);
    return rows.map((row) => ({
      eventId: row.id,
      eventType: row.event_type,
      aggregateId: row.aggregate_id,
      attempts: row.attempts,
      payload: row.payload,
    }));
  }

  async markPublished(eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) {
      return;
    }
    const placeholders = eventIds.map(() => '?').join(', ');
    await this.em.execute(
      `update outbox_events set published_at = clock_timestamp() where id in (${placeholders})`,
      [...eventIds],
    );
  }

  async correlationIdOf(aggregateId: string): Promise<string | null> {
    const [row] = await this.em.execute(
      "select payload->>'correlationId' as correlation_id from outbox_events where aggregate_id = ? order by sequence limit 1",
      [aggregateId],
    );
    return row?.correlation_id ?? null;
  }

  async scheduleRetry(eventId: string, attempts: number, delaySeconds: number, error: string): Promise<void> {
    await this.em.execute(SCHEDULE_RETRY_SQL, [attempts, delaySeconds, error, eventId]);
  }
}

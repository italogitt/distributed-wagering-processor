import type { EntityManager } from '@mikro-orm/postgresql';
import type { IntegrationEvent } from '../../../application/events';
import type { OutboxRepository } from '../../../application/ports/outbox.repository';
import { OutboxEventRecord } from '../entities/outbox-event.record';

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
}

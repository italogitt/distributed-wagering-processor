import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRepository } from '../../../application/ports/inbox.repository';
import { InboxMessageRecord } from '../entities/inbox-message.record';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async exists(consumer: string, messageId: string): Promise<boolean> {
    return (await this.em.count(InboxMessageRecord, { consumer, messageId })) > 0;
  }

  /**
   * Se outra transação gravou o mesmo par e ainda não commitou, o INSERT
   * espera por ela; se ela commitar, viola `inbox_messages_consumer_message_id_uq`.
   */
  async add(consumer: string, messageId: string, receivedAt: Date): Promise<void> {
    await this.em.insert(InboxMessageRecord, { id: Bun.randomUUIDv7(), consumer, messageId, receivedAt });
  }
}

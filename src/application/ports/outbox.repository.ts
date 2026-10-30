import type { IntegrationEvent } from '../events';

/** Grava eventos na outbox, na transação SQL corrente. Quem publica no SQS é o worker. */
export interface OutboxRepository {
  add(events: readonly IntegrationEvent<unknown>[]): Promise<void>;
}

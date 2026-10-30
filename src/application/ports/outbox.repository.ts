import type { IntegrationEvent } from '../events';

/** Evento da outbox ainda não publicado, como o publisher precisa dele. */
export interface PendingOutboxEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  /** Falhas de publicação até agora. */
  attempts: number;
  /** Envelope serializado (IntegrationEvent.toJSON()), publicado como está. */
  payload: Record<string, unknown>;
}

/** Outbox, na transação SQL corrente. */
export interface OutboxRepository {
  /** Grava eventos na mesma transação do negócio. Quem publica no SQS é o publisher. */
  add(events: readonly IntegrationEvent<unknown>[]): Promise<void>;

  /**
   * Trava (até o fim da transação) até `limit` eventos prontos para publicar:
   * pendentes, com a próxima tentativa vencida e sem evento pendente mais
   * antigo do mesmo aggregate (D18), em ordem de `sequence`. Linhas travadas
   * por outro publisher são puladas (D19).
   */
  claimPending(limit: number): Promise<PendingOutboxEvent[]>;
  markPublished(eventIds: readonly string[]): Promise<void>;
  /**
   * correlationId do primeiro evento do aggregate. Para uma PENDING_REFERENCE,
   * é o do WagerTransactionPendingReference, ou seja, o da requisição original.
   */
  correlationIdOf(aggregateId: string): Promise<string | null>;
  /** Grava a falha: novo total de tentativas e a próxima tentativa daqui a `delaySeconds`. */
  scheduleRetry(eventId: string, attempts: number, delaySeconds: number, error: string): Promise<void>;
}

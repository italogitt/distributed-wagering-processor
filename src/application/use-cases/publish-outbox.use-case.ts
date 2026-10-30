import { backoffSeconds } from '../backoff';
import type { EventPublisher } from '../ports/event-publisher';
import type { PendingOutboxEvent } from '../ports/outbox.repository';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface PublishOutboxOptions {
  /** Máximo de eventos por lote (uma transação SQL). */
  batchSize: number;
  /** Teto do backoff entre tentativas de um evento que falhou. */
  backoffMaxSeconds: number;
}

export type OutboxPublishResult =
  | { event: PendingOutboxEvent; outcome: 'published' }
  | { event: PendingOutboxEvent; outcome: 'failed'; attempts: number; retryInSeconds: number; error: unknown };

/** Tamanho máximo do erro gravado em `last_error`. */
const MAX_ERROR_LENGTH = 1_000;

/**
 * Publica um lote da outbox (seção 11). Tudo numa transação SQL:
 *
 * 1. trava os eventos prontos (`FOR UPDATE SKIP LOCKED`), então dois
 *    publishers nunca pegam o mesmo evento ao mesmo tempo;
 * 2. publica cada um;
 * 3. marca os publicados e agenda nova tentativa para os que falharam.
 *
 * Se o processo cair entre 2 e o commit, a transação faz rollback e o evento
 * sai de novo no próximo lote, com o mesmo eventId: duplicado, mas seguro
 * (deduplicação do SQS FIFO + idempotência de quem consome).
 *
 * Sem limite de tentativas: um evento nunca é descartado. O lote tem no
 * máximo um evento por aggregate (os seguintes esperam o anterior sair), então
 * os envios em paralelo não quebram a ordem.
 */
export class PublishOutboxUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly options: PublishOutboxOptions,
  ) {}

  publishBatch(): Promise<OutboxPublishResult[]> {
    return this.uow.run(async ({ outbox }) => {
      const events = await outbox.claimPending(this.options.batchSize);
      const results = await Promise.all(events.map((event) => this.publishOne(event)));

      await outbox.markPublished(results.filter((r) => r.outcome === 'published').map((r) => r.event.eventId));
      for (const result of results) {
        if (result.outcome === 'failed') {
          await outbox.scheduleRetry(result.event.eventId, result.attempts, result.retryInSeconds, describe(result.error));
        }
      }
      return results;
    });
  }

  private async publishOne(event: PendingOutboxEvent): Promise<OutboxPublishResult> {
    try {
      await this.publisher.publish(event);
      return { event, outcome: 'published' };
    } catch (error) {
      const attempts = event.attempts + 1;
      return {
        event,
        outcome: 'failed',
        attempts,
        retryInSeconds: backoffSeconds(attempts, this.options.backoffMaxSeconds),
        error,
      };
    }
  }
}

function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, MAX_ERROR_LENGTH);
}

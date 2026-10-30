import type { PublishOutboxUseCase } from '../../application/use-cases/publish-outbox.use-case';
import type { PendingOutboxEvent } from '../../application/ports/outbox.repository';
import { errorFields, type LogFields, type Logger } from '../../infrastructure/logging/logger';
import { type Metrics, NOOP_METRICS } from '../../infrastructure/metrics/metrics';
import { PollingWorker, type PollingWorkerOptions } from './polling-worker';

export interface OutboxPublisherOptions extends PollingWorkerOptions {
  queueUrl: string;
  batchSize: number;
  backoffMaxSeconds: number;
}

/** Publisher da outbox (seção 11): um lote por ciclo, um log por evento. */
export class OutboxPublisherWorker extends PollingWorker {
  constructor(
    private readonly publishOutbox: PublishOutboxUseCase,
    options: OutboxPublisherOptions,
    logger: Logger,
    private readonly metrics: Metrics = NOOP_METRICS,
  ) {
    super('outbox publisher', options, logger);
  }

  protected async tick(): Promise<number> {
    const results = await this.publishOutbox.publishBatch();
    for (const result of results) {
      const fields = eventLogFields(result.event);
      if (result.outcome === 'published') {
        this.logger.info('outbox event published', { ...fields, attempts: result.event.attempts });
      } else {
        this.metrics.retry('outbox');
        this.logger.warn('outbox event publish failed', {
          ...fields,
          attempts: result.attempts,
          retryInSeconds: result.retryInSeconds,
          ...errorFields(result.error),
        });
      }
    }
    return results.length;
  }
}

/** Ids do evento e do envelope para o log; nunca o payload (tem valores e saldo). */
function eventLogFields(event: PendingOutboxEvent): LogFields {
  const { payload } = event;
  const data = (payload.data ?? {}) as Record<string, unknown>;
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    aggregateId: event.aggregateId,
    correlationId: payload.correlationId,
    transactionId: data.transactionId,
    walletId: data.walletId,
    providerId: data.providerId,
  };
}

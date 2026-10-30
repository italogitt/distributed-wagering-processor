import type { PublishOutboxUseCase } from '../../application/use-cases/publish-outbox.use-case';
import { errorFields, type Logger } from '../../infrastructure/logging/logger';
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
  ) {
    super('outbox publisher', options, logger);
  }

  protected async tick(): Promise<number> {
    const results = await this.publishOutbox.publishBatch();
    for (const result of results) {
      const { eventId, eventType, aggregateId } = result.event;
      if (result.outcome === 'published') {
        this.logger.info('outbox event published', { eventId, eventType, aggregateId, attempts: result.event.attempts });
      } else {
        this.logger.warn('outbox event publish failed', {
          eventId,
          eventType,
          aggregateId,
          attempts: result.attempts,
          retryInSeconds: result.retryInSeconds,
          ...errorFields(result.error),
        });
      }
    }
    return results.length;
  }
}

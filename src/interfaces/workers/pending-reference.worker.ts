import type { ResolvePendingReferenceUseCase } from '../../application/use-cases/resolve-pending-reference.use-case';
import type { Logger } from '../../infrastructure/logging/logger';
import { type Metrics, NOOP_METRICS } from '../../infrastructure/metrics/metrics';
import { PollingWorker, type PollingWorkerOptions } from './polling-worker';

export interface PendingReferenceWorkerOptions extends PollingWorkerOptions {
  /** Máximo de transações por ciclo (cada uma na sua transação SQL). */
  batchSize: number;
  ttlSeconds: number;
  backoffMaxSeconds: number;
}

/** Worker agendado do PENDING_REFERENCE (seção 7.1): até `batchSize` transações por ciclo, um log por transação. */
export class PendingReferenceWorker extends PollingWorker {
  constructor(
    private readonly resolvePendingReference: ResolvePendingReferenceUseCase,
    private readonly options: PendingReferenceWorkerOptions,
    logger: Logger,
    private readonly metrics: Metrics = NOOP_METRICS,
  ) {
    super('pending reference worker', options, logger);
  }

  protected async tick(): Promise<number> {
    let handled = 0;
    while (handled < this.options.batchSize) {
      const startedAt = performance.now();
      const resolution = await this.resolvePendingReference.resolveNext();
      if (!resolution) break;
      handled += 1;
      const durationMs = performance.now() - startedAt;
      if (resolution.outcome === 'decided') {
        this.metrics.transactionDecided({ source: 'worker', ...resolution, idempotentReplay: false });
        this.metrics.observeProcessing('worker', durationMs / 1_000);
      } else {
        this.metrics.retry('pending_reference');
      }
      this.logger.info('pending reference handled', { ...resolution, durationMs: Math.round(durationMs) });
    }
    return handled;
  }
}

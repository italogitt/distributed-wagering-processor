import type { ResolvePendingReferenceUseCase } from '../../application/use-cases/resolve-pending-reference.use-case';
import type { Logger } from '../../infrastructure/logging/logger';
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
  ) {
    super('pending reference worker', options, logger);
  }

  protected async tick(): Promise<number> {
    let handled = 0;
    while (handled < this.options.batchSize) {
      const resolution = await this.resolvePendingReference.resolveNext();
      if (!resolution) break;
      handled += 1;
      this.logger.info('pending reference handled', { ...resolution });
    }
    return handled;
  }
}

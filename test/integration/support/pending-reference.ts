import './env';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  type ResolvePendingReferenceOptions,
  ResolvePendingReferenceUseCase,
} from '../../../src/application/use-cases/resolve-pending-reference.use-case';
import config from '../../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { UuidV7IdGenerator } from '../../../src/infrastructure/uuid-v7-id-generator';
import { PendingReferenceWorker } from '../../../src/interfaces/workers/pending-reference.worker';
import { CapturingLogger } from './consumer';

export interface PendingReferenceHarness {
  useCase: ResolvePendingReferenceUseCase;
  worker: PendingReferenceWorker;
  logger: CapturingLogger;
  close(): Promise<void>;
}

/** Um worker como o da app (MikroORM com pool próprio). TTL padrão de 1 h: só expira quando o teste pede. */
export async function createPendingReferenceWorker(
  options: Partial<ResolvePendingReferenceOptions> = {},
): Promise<PendingReferenceHarness> {
  const orm = await MikroORM.init(config);
  const resolved = { ttlMs: 3_600_000, backoffMaxSeconds: 60, ...options };
  const useCase = new ResolvePendingReferenceUseCase(new MikroOrmUnitOfWork(orm.em), new UuidV7IdGenerator(), resolved);
  const logger = new CapturingLogger();
  const worker = new PendingReferenceWorker(
    useCase,
    {
      enabled: false,
      batchSize: 10,
      idleDelayMs: 50,
      ttlSeconds: resolved.ttlMs / 1_000,
      backoffMaxSeconds: resolved.backoffMaxSeconds,
      shutdownTimeoutMs: 2_000,
    },
    logger,
  );
  return {
    useCase,
    worker,
    logger,
    close: async () => {
      await worker.stop();
      await orm.close();
    },
  };
}

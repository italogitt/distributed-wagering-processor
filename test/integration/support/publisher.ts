import './env';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { PublishOutboxUseCase } from '../../../src/application/use-cases/publish-outbox.use-case';
import config from '../../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SqsEventPublisher } from '../../../src/infrastructure/sqs/sqs-event-publisher';
import { type OutboxPublisherOptions, OutboxPublisherWorker } from '../../../src/interfaces/workers/outbox-publisher.worker';
import { CapturingLogger } from './consumer';
import { sqs as realSqs } from './sqs';

export const FAST_PUBLISHER = {
  enabled: false,
  batchSize: 10,
  idleDelayMs: 100,
  backoffMaxSeconds: 60,
  shutdownTimeoutMs: 2_000,
} satisfies Partial<OutboxPublisherOptions>;

export interface PublisherHarness {
  useCase: PublishOutboxUseCase;
  worker: OutboxPublisherWorker;
  logger: CapturingLogger;
  close(): Promise<void>;
}

/** Um publisher como o da app (MikroORM com pool próprio), com pontos de injeção: `sqs` e `wrapUnitOfWork`. */
export async function createPublisher(
  queueUrl: string,
  overrides: {
    options?: Partial<OutboxPublisherOptions>;
    wrapUnitOfWork?: (uow: UnitOfWork) => UnitOfWork;
    sqs?: SQSClient;
  } = {},
): Promise<PublisherHarness> {
  const orm = await MikroORM.init(config);
  const realUow = new MikroOrmUnitOfWork(orm.em);
  const uow = overrides.wrapUnitOfWork ? overrides.wrapUnitOfWork(realUow) : realUow;
  const options = { ...FAST_PUBLISHER, queueUrl, ...overrides.options };
  const useCase = new PublishOutboxUseCase(uow, new SqsEventPublisher(overrides.sqs ?? realSqs, queueUrl), options);
  const logger = new CapturingLogger();
  const worker = new OutboxPublisherWorker(useCase, options, logger);
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

import './env';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { SubmitTransactionUseCase } from '../../../src/application/use-cases/submit-transaction.use-case';
import type { LogFields, Logger } from '../../../src/infrastructure/logging/logger';
import config from '../../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { UuidV7IdGenerator } from '../../../src/infrastructure/uuid-v7-id-generator';
import { type SqsConsumerOptions, SqsWagerConsumer } from '../../../src/interfaces/sqs/sqs-wager-consumer';
import { sqs as realSqs, type TestQueues } from './sqs';

export interface LogLine extends LogFields {
  level: string;
  message: string;
}

/** Guarda os logs em memória, para os testes conferirem outcome e campos. */
export class CapturingLogger implements Logger {
  readonly lines: LogLine[] = [];
  info(message: string, fields: LogFields = {}) {
    this.lines.push({ level: 'info', message, ...fields });
  }
  warn(message: string, fields: LogFields = {}) {
    this.lines.push({ level: 'warn', message, ...fields });
  }
  error(message: string, fields: LogFields = {}) {
    this.lines.push({ level: 'error', message, ...fields });
  }
  outcomes(): string[] {
    return this.lines.filter((l) => l.message === 'sqs message handled').map((l) => String(l.outcome));
  }
}

/** Tempos curtos para os testes rodarem em segundos. */
export const FAST_OPTIONS = {
  enabled: false,
  consumerName: 'wager-transactions',
  waitTimeSeconds: 1,
  visibilityTimeoutSeconds: 5,
  maxMessages: 10,
  backoffMaxSeconds: 1,
  shutdownTimeoutMs: 2_000,
} satisfies Partial<SqsConsumerOptions>;

export interface ConsumerHarness {
  consumer: SqsWagerConsumer;
  logger: CapturingLogger;
  close(): Promise<void>;
}

/**
 * Um consumer como o da app (caso de uso + MikroORM reais, com pool próprio),
 * com pontos de injeção de falha: `wrapUnitOfWork` e `sqs`.
 */
export async function createConsumer(
  queues: TestQueues,
  overrides: {
    options?: Partial<SqsConsumerOptions>;
    wrapUnitOfWork?: (uow: UnitOfWork) => UnitOfWork;
    sqs?: SQSClient;
  } = {},
): Promise<ConsumerHarness> {
  const orm = await MikroORM.init(config);
  const realUow = new MikroOrmUnitOfWork(orm.em);
  const uow = overrides.wrapUnitOfWork ? overrides.wrapUnitOfWork(realUow) : realUow;
  const logger = new CapturingLogger();
  const consumer = new SqsWagerConsumer(
    overrides.sqs ?? realSqs,
    new SubmitTransactionUseCase(uow, new UuidV7IdGenerator()),
    { ...FAST_OPTIONS, ...queues, ...overrides.options },
    logger,
  );
  return {
    consumer,
    logger,
    close: async () => {
      await consumer.stop();
      await orm.close();
    },
  };
}

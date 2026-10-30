import type { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SubmitTransactionUseCase } from './application/use-cases/submit-transaction.use-case';
import { JsonLogger } from './infrastructure/logging/logger';
import mikroOrmConfig from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { createSqsClient, loadSqsConfig, type SqsConfig } from './infrastructure/sqs/sqs.config';
import { UuidV7IdGenerator } from './infrastructure/uuid-v7-id-generator';
import { ApplicationErrorFilter } from './interfaces/http/application-error.filter';
import {
  HEALTH_DEPENDENCIES,
  HealthController,
  type HealthDependencies,
  SQS_CLIENT,
} from './interfaces/http/health.controller';
import { WageringController } from './interfaces/http/wagering.controller';
import { SqsWagerConsumer } from './interfaces/sqs/sqs-wager-consumer';

const SQS_CONFIG = Symbol('SQS_CONFIG');

@Module({
  imports: [
    // Sem request context: o UnitOfWork faz `fork()` a cada transação.
    MikroOrmModule.forRoot({ ...mikroOrmConfig, registerRequestContext: false }),
  ],
  controllers: [WageringController, HealthController],
  providers: [
    { provide: APP_FILTER, useClass: ApplicationErrorFilter },
    {
      // O caso de uso não conhece o Nest: a montagem fica aqui.
      provide: SubmitTransactionUseCase,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new SubmitTransactionUseCase(new MikroOrmUnitOfWork(em), new UuidV7IdGenerator()),
    },
    { provide: SQS_CONFIG, useFactory: () => loadSqsConfig() },
    { provide: SQS_CLIENT, inject: [SQS_CONFIG], useFactory: (config: SqsConfig) => createSqsClient(config) },
    {
      provide: HEALTH_DEPENDENCIES,
      inject: [EntityManager, SQS_CLIENT, SQS_CONFIG],
      useFactory: (em: EntityManager, sqs: SQSClient, config: SqsConfig): HealthDependencies => ({
        em,
        sqs,
        queueUrl: config.consumer.queueUrl,
      }),
    },
    {
      // Liga sozinho no bootstrap se SQS_CONSUMER_ENABLED=true; para no shutdown.
      provide: SqsWagerConsumer,
      inject: [SQS_CLIENT, SubmitTransactionUseCase, SQS_CONFIG],
      useFactory: (sqs: SQSClient, useCase: SubmitTransactionUseCase, config: SqsConfig) =>
        new SqsWagerConsumer(sqs, useCase, config.consumer, new JsonLogger('SqsWagerConsumer')),
    },
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  /** Fecha as conexões HTTP do SDK depois que o consumer já parou. */
  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}

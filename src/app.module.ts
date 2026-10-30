import type { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PublishOutboxUseCase } from './application/use-cases/publish-outbox.use-case';
import { ResolvePendingReferenceUseCase } from './application/use-cases/resolve-pending-reference.use-case';
import { SubmitTransactionUseCase } from './application/use-cases/submit-transaction.use-case';
import { errorFields, JsonLogger } from './infrastructure/logging/logger';
import { MeteredUnitOfWork } from './infrastructure/metrics/metered-unit-of-work';
import { type Metrics, PrometheusMetrics } from './infrastructure/metrics/metrics';
import mikroOrmConfig from './infrastructure/persistence/mikro-orm.config';
import { readOutboxBacklog } from './infrastructure/persistence/outbox-backlog';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher';
import { createSqsClient, loadSqsConfig, type SqsConfig } from './infrastructure/sqs/sqs.config';
import { UuidV7IdGenerator } from './infrastructure/uuid-v7-id-generator';
import { loadOutboxPublisherConfig, loadPendingReferenceConfig } from './infrastructure/workers.config';
import { ApplicationErrorFilter } from './interfaces/http/application-error.filter';
import {
  HEALTH_DEPENDENCIES,
  HealthController,
  type HealthDependencies,
  SQS_CLIENT,
} from './interfaces/http/health.controller';
import { METRICS, METRICS_REGISTRY, MetricsController } from './interfaces/http/metrics.controller';
import { WAGERING_LOGGER, WageringController } from './interfaces/http/wagering.controller';
import { SqsWagerConsumer } from './interfaces/sqs/sqs-wager-consumer';
import { OutboxPublisherWorker } from './interfaces/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from './interfaces/workers/pending-reference.worker';

const SQS_CONFIG = Symbol('SQS_CONFIG');

@Module({
  imports: [
    // Sem request context: o UnitOfWork faz `fork()` a cada transação.
    MikroOrmModule.forRoot({ ...mikroOrmConfig, registerRequestContext: false }),
  ],
  controllers: [WageringController, HealthController, MetricsController],
  providers: [
    { provide: APP_FILTER, useClass: ApplicationErrorFilter },
    {
      // Um Registry por app (não o global do prom-client): métricas da instância.
      provide: PrometheusMetrics,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => {
        const logger = new JsonLogger('Metrics');
        return new PrometheusMetrics(
          () => readOutboxBacklog(em),
          (error) => logger.warn('outbox backlog read failed', errorFields(error)),
        );
      },
    },
    { provide: METRICS, useExisting: PrometheusMetrics },
    { provide: METRICS_REGISTRY, inject: [PrometheusMetrics], useFactory: (m: PrometheusMetrics) => m.registry },
    { provide: WAGERING_LOGGER, useFactory: () => new JsonLogger('WageringController') },
    {
      // O caso de uso não conhece o Nest: a montagem fica aqui.
      provide: SubmitTransactionUseCase,
      inject: [EntityManager, METRICS],
      useFactory: (em: EntityManager, metrics: Metrics) =>
        new SubmitTransactionUseCase(new MeteredUnitOfWork(new MikroOrmUnitOfWork(em), metrics), new UuidV7IdGenerator()),
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
      inject: [SQS_CLIENT, SubmitTransactionUseCase, SQS_CONFIG, METRICS],
      useFactory: (sqs: SQSClient, useCase: SubmitTransactionUseCase, config: SqsConfig, metrics: Metrics) =>
        new SqsWagerConsumer(sqs, useCase, config.consumer, new JsonLogger('SqsWagerConsumer'), metrics),
    },
    {
      // Liga sozinho se OUTBOX_PUBLISHER_ENABLED=true; no SIGTERM termina o lote atual.
      provide: OutboxPublisherWorker,
      inject: [EntityManager, SQS_CLIENT, METRICS],
      useFactory: (em: EntityManager, sqs: SQSClient, metrics: Metrics) => {
        const options = loadOutboxPublisherConfig();
        const useCase = new PublishOutboxUseCase(
          new MikroOrmUnitOfWork(em),
          new SqsEventPublisher(sqs, options.queueUrl),
          options,
        );
        return new OutboxPublisherWorker(useCase, options, new JsonLogger('OutboxPublisher'), metrics);
      },
    },
    {
      // Liga sozinho se PENDING_REFERENCE_WORKER_ENABLED=true; no SIGTERM termina a transação atual.
      provide: PendingReferenceWorker,
      inject: [EntityManager, METRICS],
      useFactory: (em: EntityManager, metrics: Metrics) => {
        const options = loadPendingReferenceConfig();
        const useCase = new ResolvePendingReferenceUseCase(new MikroOrmUnitOfWork(em), new UuidV7IdGenerator(), {
          ttlMs: options.ttlSeconds * 1_000,
          backoffMaxSeconds: options.backoffMaxSeconds,
        });
        return new PendingReferenceWorker(useCase, options, new JsonLogger('PendingReferenceWorker'), metrics);
      },
    },
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  /** Fecha as conexões HTTP do SDK depois que o consumer e os workers já pararam. */
  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}

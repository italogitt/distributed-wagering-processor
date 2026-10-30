import { SQSClient } from '@aws-sdk/client-sqs';
import type { SqsConsumerOptions } from '../../interfaces/sqs/sqs-wager-consumer';
import { type Env, flag, integer, LOCALSTACK_QUEUE_BASE } from '../env';

export interface SqsConfig {
  region: string;
  /** Só em desenvolvimento e testes (LocalStack). Vazio = AWS de verdade. */
  endpoint?: string;
  consumer: SqsConsumerOptions;
}

/** Tudo vem de env, com defaults para o docker-compose local. */
export function loadSqsConfig(env: Env = process.env): SqsConfig {
  return {
    region: env.AWS_REGION ?? 'us-east-1',
    endpoint: env.SQS_ENDPOINT ?? 'http://localhost:4566',
    consumer: {
      enabled: flag(env, 'SQS_CONSUMER_ENABLED'),
      consumerName: env.SQS_CONSUMER_NAME ?? 'wager-transactions',
      queueUrl: env.SQS_WAGER_QUEUE_URL ?? `${LOCALSTACK_QUEUE_BASE}/wager-transactions.fifo`,
      dlqUrl: env.SQS_WAGER_DLQ_URL ?? `${LOCALSTACK_QUEUE_BASE}/wager-transactions-dlq.fifo`,
      waitTimeSeconds: integer(env, 'SQS_WAIT_TIME_SECONDS', 20),
      visibilityTimeoutSeconds: integer(env, 'SQS_VISIBILITY_TIMEOUT_SECONDS', 30),
      maxMessages: integer(env, 'SQS_MAX_MESSAGES', 10),
      backoffMaxSeconds: integer(env, 'SQS_BACKOFF_MAX_SECONDS', 60),
      shutdownTimeoutMs: integer(env, 'SQS_SHUTDOWN_TIMEOUT_MS', 10_000),
    },
  };
}

export function createSqsClient(config: SqsConfig): SQSClient {
  return new SQSClient({
    region: config.region,
    endpoint: config.endpoint,
    // O LocalStack aceita qualquer credencial; na AWS vem da cadeia padrão do SDK.
    credentials: config.endpoint
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
        }
      : undefined,
  });
}

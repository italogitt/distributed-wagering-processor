import type { OutboxPublisherOptions } from '../interfaces/workers/outbox-publisher.worker';
import type { PendingReferenceWorkerOptions } from '../interfaces/workers/pending-reference.worker';
import { type Env, flag, integer, LOCALSTACK_QUEUE_BASE } from './env';

/** Publisher da outbox. Defaults para o docker-compose local. */
export function loadOutboxPublisherConfig(env: Env = process.env): OutboxPublisherOptions {
  return {
    enabled: flag(env, 'OUTBOX_PUBLISHER_ENABLED'),
    queueUrl: env.SQS_WALLET_EVENTS_QUEUE_URL ?? `${LOCALSTACK_QUEUE_BASE}/wallet-events.fifo`,
    batchSize: integer(env, 'OUTBOX_BATCH_SIZE', 10),
    idleDelayMs: integer(env, 'OUTBOX_POLL_INTERVAL_MS', 1_000),
    backoffMaxSeconds: integer(env, 'OUTBOX_BACKOFF_MAX_SECONDS', 60),
    shutdownTimeoutMs: integer(env, 'OUTBOX_SHUTDOWN_TIMEOUT_MS', 10_000),
  };
}

/**
 * Worker do PENDING_REFERENCE. TTL padrão de 10 min: com backoff até 60 s,
 * são ~15 tentativas; uma referência que não chega nesse tempo dificilmente
 * é atraso de entrega, e o provedor precisa da resposta (REFERENCE_NOT_FOUND).
 */
export function loadPendingReferenceConfig(env: Env = process.env): PendingReferenceWorkerOptions {
  return {
    enabled: flag(env, 'PENDING_REFERENCE_WORKER_ENABLED'),
    batchSize: integer(env, 'PENDING_REFERENCE_BATCH_SIZE', 10),
    idleDelayMs: integer(env, 'PENDING_REFERENCE_POLL_INTERVAL_MS', 1_000),
    ttlSeconds: integer(env, 'PENDING_REFERENCE_TTL_SECONDS', 600),
    backoffMaxSeconds: integer(env, 'PENDING_REFERENCE_BACKOFF_MAX_SECONDS', 60),
    shutdownTimeoutMs: integer(env, 'PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS', 10_000),
  };
}

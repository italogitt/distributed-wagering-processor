import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export type TransactionSource = 'http' | 'sqs' | 'worker';
export type RetryComponent = 'sqs_consumer' | 'outbox' | 'pending_reference';
/** malformed_message: corpo inválido (JSON, type, campos); invalid_input: o caso de uso recusou o payload (400). */
export type DlqReason = 'malformed_message' | 'invalid_input';

/** Uma decisão do caso de uso (HTTP, SQS) ou do worker. */
export interface TransactionDecision {
  source: TransactionSource;
  kind: string;
  status: string;
  failureCode?: string;
  idempotentReplay: boolean;
}

/**
 * O que as bordas (controller, consumer, publisher, worker) registram. As
 * métricas são da instância: cada processo expõe as suas no /metrics, e
 * quem agrega entre instâncias é o Prometheus.
 */
export interface Metrics {
  transactionDecided(decision: TransactionDecision): void;
  inboxDuplicate(): void;
  retry(component: RetryComponent): void;
  dlq(reason: DlqReason): void;
  /** UniqueViolation na transação SQL: outra requisição venceu a corrida (dispara o retry do caso de uso). */
  uniqueViolation(): void;
  observeProcessing(source: TransactionSource, seconds: number): void;
}

export const NOOP_METRICS: Metrics = {
  transactionDecided: () => {},
  inboxDuplicate: () => {},
  retry: () => {},
  dlq: () => {},
  uniqueViolation: () => {},
  observeProcessing: () => {},
};

export interface OutboxBacklog {
  pending: number;
  /** Idade do evento pendente mais antigo; 0 sem pendentes. */
  oldestAgeSeconds: number;
}

/**
 * Débito recusado pelo UPDATE condicional (`balance >= valor`, D10): é onde
 * a disputa pelo saldo se resolve, já que não há lock pessimista.
 */
const CONDITIONAL_DEBIT_REJECTIONS: readonly string[] = ['INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS'];

/** Métricas no formato do Prometheus, num Registry próprio da app (não o global do prom-client). */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'transactions_total',
    help: 'Transações decididas (replays ficam em duplicates_total)',
    labelNames: ['status', 'kind', 'source'] as const,
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: 'duplicates_total',
    help: 'Duplicatas detectadas: replay pela idempotencyKey ou mensagem já na inbox',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: 'retries_total',
    help: 'Novas tentativas agendadas por componente',
    labelNames: ['component'] as const,
    registers: [this.registry],
  });

  private readonly dlqMessages = new Counter({
    name: 'dlq_messages_total',
    help: 'Mensagens enviadas à DLQ pelo consumer (o redrive após maxReceiveCount é do SQS e não passa por aqui)',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  private readonly conflicts = new Counter({
    name: 'concurrency_conflicts_total',
    help: 'Conflitos de concorrência: UniqueViolation (retry) e débito recusado pelo UPDATE condicional',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  private readonly processing = new Histogram({
    name: 'transaction_processing_seconds',
    help: 'Latência de processamento de uma transação, por origem',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  /**
   * @param readOutboxBacklog consulta feita a cada coleta (scrape), não em background.
   * @param onCollectError se a consulta falhar, os gauges ficam com o último valor e o erro vai para cá.
   */
  constructor(readOutboxBacklog: () => Promise<OutboxBacklog>, onCollectError: (error: unknown) => void) {
    // Os dois gauges coletam em paralelo: compartilham uma consulta por scrape.
    let inflight: Promise<OutboxBacklog | undefined> | undefined;
    const backlog = () =>
      (inflight ??= readOutboxBacklog()
        .catch((error: unknown) => {
          onCollectError(error);
          return undefined;
        })
        .finally(() => {
          inflight = undefined;
        }));

    new Gauge({
      name: 'outbox_pending_events',
      help: 'Eventos da outbox ainda não publicados',
      registers: [this.registry],
      async collect() {
        const value = await backlog();
        if (value) this.set(value.pending);
      },
    });
    new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Idade do evento pendente mais antigo da outbox',
      registers: [this.registry],
      async collect() {
        const value = await backlog();
        if (value) this.set(value.oldestAgeSeconds);
      },
    });
  }

  transactionDecided(decision: TransactionDecision): void {
    if (decision.idempotentReplay) {
      // O resultado já foi contado quando a transação foi decidida.
      this.duplicates.inc({ type: 'idempotent_replay' });
      return;
    }
    this.transactions.inc({ status: decision.status, kind: decision.kind, source: decision.source });
    if (decision.failureCode && CONDITIONAL_DEBIT_REJECTIONS.includes(decision.failureCode)) {
      this.conflicts.inc({ type: 'conditional_debit_rejected' });
    }
  }

  inboxDuplicate(): void {
    this.duplicates.inc({ type: 'inbox_duplicate' });
  }

  retry(component: RetryComponent): void {
    this.retries.inc({ component });
  }

  dlq(reason: DlqReason): void {
    this.dlqMessages.inc({ reason });
  }

  uniqueViolation(): void {
    this.conflicts.inc({ type: 'unique_violation' });
  }

  observeProcessing(source: TransactionSource, seconds: number): void {
    this.processing.observe({ source }, seconds);
  }
}

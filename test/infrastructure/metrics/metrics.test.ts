import { describe, expect, test } from 'bun:test';
import { type OutboxBacklog, PrometheusMetrics } from '../../../src/infrastructure/metrics/metrics';

const noBacklog = async (): Promise<OutboxBacklog> => ({ pending: 0, oldestAgeSeconds: 0 });

function metrics(readBacklog = noBacklog, onError: (error: unknown) => void = () => {}) {
  return new PrometheusMetrics(readBacklog, onError);
}

/** Valor de uma série no texto do /metrics, ou undefined se ela não existe. */
async function sample(m: PrometheusMetrics, series: string): Promise<number | undefined> {
  const line = (await m.registry.metrics()).split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe('transactionDecided', () => {
  test('decisão nova → transactions_total{status, kind, source}', async () => {
    const m = metrics();
    m.transactionDecided({ source: 'http', kind: 'BET', status: 'PROCESSED', idempotentReplay: false });
    m.transactionDecided({ source: 'http', kind: 'BET', status: 'PROCESSED', idempotentReplay: false });

    expect(await sample(m, 'transactions_total{status="PROCESSED",kind="BET",source="http"}')).toBe(2);
  });

  test('replay → só duplicates_total{idempotent_replay}; o resultado já foi contado', async () => {
    const m = metrics();
    m.transactionDecided({ source: 'sqs', kind: 'BET', status: 'PROCESSED', idempotentReplay: true });

    expect(await sample(m, 'duplicates_total{type="idempotent_replay"}')).toBe(1);
    expect(await sample(m, 'transactions_total{status="PROCESSED",kind="BET",source="sqs"}')).toBeUndefined();
  });

  test('débito recusado pelo UPDATE condicional → concurrency_conflicts_total{conditional_debit_rejected}', async () => {
    const m = metrics();
    m.transactionDecided({
      source: 'http',
      kind: 'BET',
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      idempotentReplay: false,
    });
    m.transactionDecided({
      source: 'worker',
      kind: 'ROLLBACK',
      status: 'REJECTED',
      failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
      idempotentReplay: false,
    });
    m.transactionDecided({
      source: 'worker',
      kind: 'REFUND',
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
      idempotentReplay: false,
    });

    expect(await sample(m, 'concurrency_conflicts_total{type="conditional_debit_rejected"}')).toBe(2);
  });
});

test('contadores simples por label', async () => {
  const m = metrics();
  m.inboxDuplicate();
  m.retry('outbox');
  m.retry('outbox');
  m.dlq('invalid_input');
  m.uniqueViolation();

  expect(await sample(m, 'duplicates_total{type="inbox_duplicate"}')).toBe(1);
  expect(await sample(m, 'retries_total{component="outbox"}')).toBe(2);
  expect(await sample(m, 'dlq_messages_total{reason="invalid_input"}')).toBe(1);
  expect(await sample(m, 'concurrency_conflicts_total{type="unique_violation"}')).toBe(1);
});

test('histograma por source', async () => {
  const m = metrics();
  m.observeProcessing('worker', 0.02);

  expect(await sample(m, 'transaction_processing_seconds_count{source="worker"}')).toBe(1);
  expect(await sample(m, 'transaction_processing_seconds_bucket{le="0.025",source="worker"}')).toBe(1);
  expect(await sample(m, 'transaction_processing_seconds_bucket{le="0.01",source="worker"}')).toBe(0);
});

describe('gauges da outbox', () => {
  test('calculados no scrape, com UMA consulta para os dois', async () => {
    let calls = 0;
    const m = metrics(async () => {
      calls += 1;
      return { pending: 3, oldestAgeSeconds: 12.5 };
    });

    expect(await sample(m, 'outbox_pending_events')).toBe(3);
    expect(calls).toBe(1);
    expect(await sample(m, 'outbox_lag_seconds')).toBe(12.5);
    expect(calls).toBe(2); // novo scrape, nova consulta
  });

  test('consulta falha → o scrape responde mesmo assim e o erro é reportado', async () => {
    const errors: unknown[] = [];
    const m = metrics(async () => {
      throw new Error('db down');
    }, (error) => errors.push(error));

    expect(await sample(m, 'outbox_pending_events')).toBe(0);
    expect(errors).toHaveLength(1);
  });
});

test('Registry próprio: duas instâncias na mesma app/processo não colidem', async () => {
  const a = metrics();
  const b = metrics();
  a.retry('sqs_consumer');

  expect(await sample(a, 'retries_total{component="sqs_consumer"}')).toBe(1);
  expect(await sample(b, 'retries_total{component="sqs_consumer"}')).toBeUndefined();
});

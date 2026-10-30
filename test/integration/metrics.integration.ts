import { afterAll, beforeAll, expect, test } from 'bun:test';
import { type RunningApp, startApp, submit, transactionBody } from './support/app';
import { closeDatabase, discardPendingOutbox, pendingOutboxCount, resetDatabase, seedWallet } from './support/database';

let app: RunningApp;

beforeAll(async () => {
  await resetDatabase();
  app = await startApp(); // sem publisher: os eventos ficam pendentes
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
});

async function scrape(): Promise<{ contentType: string | null; text: string }> {
  const response = await fetch(`${app.url}/metrics`);
  expect(response.status).toBe(200);
  return { contentType: response.headers.get('content-type'), text: await response.text() };
}

/** Valor de uma série no formato de texto do Prometheus. */
function sample(text: string, series: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

test('BET via HTTP → /metrics com transactions_total PROCESSED 1 e outbox_pending_events coerente', async () => {
  const wallet = await seedWallet('100.00');
  await discardPendingOutbox();
  const body = transactionBody(wallet, 'BET', '10.00');

  const bet = await submit(app.url, `provider-a:${body.externalTransactionId}`, body);
  expect(bet.body.status).toBe('PROCESSED');

  const { contentType, text } = await scrape();
  expect(contentType).toContain('version=0.0.4'); // formato de texto do Prometheus
  expect(sample(text, 'transactions_total{status="PROCESSED",kind="BET",source="http"}')).toBe(1);
  expect(sample(text, 'transaction_processing_seconds_count{source="http"}')).toBe(1);
  // WagerTransactionProcessed + WalletBalanceChanged, ninguém publicando.
  expect(sample(text, 'outbox_pending_events')).toBe(2);
  expect(await pendingOutboxCount()).toBe(2);
  expect(sample(text, 'outbox_lag_seconds')).toBeGreaterThan(0);

  // Replay da mesma key: conta como duplicata, não como nova transação.
  await submit(app.url, `provider-a:${body.externalTransactionId}`, body);
  const after = (await scrape()).text;
  expect(sample(after, 'transactions_total{status="PROCESSED",kind="BET",source="http"}')).toBe(1);
  expect(sample(after, 'duplicates_total{type="idempotent_replay"}')).toBe(1);
  expect(sample(after, 'outbox_pending_events')).toBe(2);
});

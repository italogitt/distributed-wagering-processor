import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import type {
  PendingReferenceResolution,
  ResolvePendingReferenceUseCase,
} from '../../src/application/use-cases/resolve-pending-reference.use-case';
import { type RunningApp, startApp, submit, type TransactionBody, transactionBody } from './support/app';
import {
  assertLedgerInvariant,
  closeDatabase,
  countByStatus,
  countLedgerEntries,
  outboxRows,
  parkPendingReferences,
  resetDatabase,
  type SeededWallet,
  seedWallet,
  transactionRow,
  walletState,
} from './support/database';
import { createPendingReferenceWorker, type PendingReferenceHarness } from './support/pending-reference';
import { waitUntil } from './support/sqs';

// A 1ª nova tentativa vence 1 s depois do 202 (FIRST_REFERENCE_RETRY_MS); os testes esperam por ela.
const TEST_TIMEOUT_MS = 20_000;

let app: RunningApp;
let harnesses: PendingReferenceHarness[] = [];

beforeAll(async () => {
  await resetDatabase();
  app = await startApp(); // sem worker: quem resolve é o harness de cada teste
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
});

beforeEach(parkPendingReferences);

afterEach(async () => {
  await Promise.all(harnesses.map((h) => h.close()));
  harnesses = [];
  await assertLedgerInvariant();
});

async function worker(options: Parameters<typeof createPendingReferenceWorker>[0] = {}) {
  const harness = await createPendingReferenceWorker(options);
  harnesses.push(harness);
  return harness;
}

const post = (body: TransactionBody, requestId?: string) =>
  submit(app.url, `${body.providerId}:${body.externalTransactionId}`, body, requestId);

/** Espera a próxima tentativa vencer e resolve uma transação. */
const resolveWhenDue = (useCase: ResolvePendingReferenceUseCase) =>
  waitUntil(
    () => useCase.resolveNext(),
    (r): r is PendingReferenceResolution => r !== null,
    { timeoutMs: 5_000, intervalMs: 100 },
  ) as Promise<PendingReferenceResolution>;

/** REFUND/ROLLBACK cuja referência (`ref`) ainda não chegou. */
const reversal = (wallet: SeededWallet, kind: string, amount: string, ref: string) =>
  transactionBody(wallet, kind, amount, { referenceExternalTransactionId: ref });

test(
  'B1. REFUND chega antes da BET → 202; a BET chega e o worker roda → REFUND PROCESSED e saldo correto',
  async () => {
    const wallet = await seedWallet('100.00');
    const betId = `bet-${Bun.randomUUIDv7()}`;
    const refund = await post(reversal(wallet, 'REFUND', '10.00', betId), 'req-b1');
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe('PENDING_REFERENCE');

    const bet = await post(transactionBody(wallet, 'BET', '10.00', { externalTransactionId: betId }));
    expect(bet.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '90.00' } });

    const { useCase } = await worker();
    const resolution = await resolveWhenDue(useCase);

    expect(resolution).toMatchObject({
      transactionId: refund.body.transactionId,
      outcome: 'decided',
      status: 'PROCESSED',
      attempts: 1,
    });
    expect(await walletState(wallet.id)).toEqual({ balance: '100.00', version: 3 });
    expect(await countLedgerEntries(wallet.id)).toBe(3); // abertura, BET, REFUND
    expect(await transactionRow(refund.body.transactionId)).toMatchObject({
      status: 'PROCESSED',
      reference_transaction_id: bet.body.transactionId,
      balance_after: '100.00',
      next_attempt_at: null,
      attempts: 1,
    });

    // Eventos do worker: correlationId da requisição original, causationId = o REFUND.
    const events = (await outboxRows({ walletId: wallet.id })).filter(
      (e) => e.payload.causationId === refund.body.transactionId,
    );
    expect(events.map((e) => e.eventType)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const event of events) expect(event.payload.correlationId).toBe('req-b1');
  },
  TEST_TIMEOUT_MS,
);

test(
  'B2. referência nunca chega → depois do TTL: REJECTED REFERENCE_NOT_FOUND + WagerTransactionRejected',
  async () => {
    const wallet = await seedWallet('100.00');
    const refund = await post(reversal(wallet, 'REFUND', '10.00', `bet-${Bun.randomUUIDv7()}`));
    expect(refund.status).toBe(202);

    // TTL de 500 ms: quando a 1ª tentativa vence (1 s), já expirou.
    const { useCase } = await worker({ ttlMs: 500 });
    const resolution = await resolveWhenDue(useCase);

    expect(resolution).toMatchObject({ outcome: 'decided', status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
    expect(await transactionRow(refund.body.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      balance_after: '100.00',
      next_attempt_at: null,
    });
    const rejected = (await outboxRows({ aggregateId: refund.body.transactionId })).at(-1)!;
    expect(rejected.eventType).toBe('WagerTransactionRejected');
    expect(rejected.payload.data).toMatchObject({ failureCode: 'REFERENCE_NOT_FOUND', balanceAfter: { amount: '100.00' } });
    expect(await walletState(wallet.id)).toEqual({ balance: '100.00', version: 1 });
  },
  TEST_TIMEOUT_MS,
);

test(
  'B3. antes do TTL → só attempts e next_attempt_at mudam',
  async () => {
    const wallet = await seedWallet('100.00');
    const refund = await post(reversal(wallet, 'REFUND', '10.00', `bet-${Bun.randomUUIDv7()}`));
    const before = await transactionRow(refund.body.transactionId);

    const { useCase } = await worker();
    const resolution = await resolveWhenDue(useCase);
    const after = await transactionRow(refund.body.transactionId);

    expect(resolution).toMatchObject({ outcome: 'rescheduled', attempts: 1 });
    expect(after.attempts).toBe(1);
    // Backoff da 1ª falha: 2 s a partir de agora.
    const delayMs = new Date(after.next_attempt_at as string).getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(1_000);
    expect(delayMs).toBeLessThanOrEqual(2_000);
    const unchanged = (row: Record<string, unknown>) => {
      const { attempts, next_attempt_at, next_attempt_at_text, ...rest } = row;
      return rest;
    };
    expect(unchanged(after)).toEqual(unchanged(before));
    expect((await outboxRows({ aggregateId: refund.body.transactionId })).map((e) => e.eventType)).toEqual([
      'WagerTransactionPendingReference',
    ]);
  },
  TEST_TIMEOUT_MS,
);

test(
  'B4. três workers ao mesmo tempo sobre 20 pendentes → cada uma resolvida exatamente uma vez',
  async () => {
    const wallet = await seedWallet('1000.00');
    const betIds = Array.from({ length: 20 }, () => `bet-${Bun.randomUUIDv7()}`);
    const refunds = await Promise.all(betIds.map((id) => post(reversal(wallet, 'REFUND', '10.00', id))));
    expect(refunds.every((r) => r.status === 202)).toBe(true);
    for (const id of betIds) {
      await post(transactionBody(wallet, 'BET', '10.00', { externalTransactionId: id }));
    }
    expect(await walletState(wallet.id)).toMatchObject({ balance: '800.00' });

    const workers = await Promise.all([worker(), worker(), worker()]);
    await Bun.sleep(1_100); // todas vencidas: os três disputam as mesmas linhas
    for (const w of workers) w.worker.start();
    await waitUntil(() => countByStatus(wallet.id, 'PENDING_REFERENCE'), (n) => n === 0);
    await Promise.all(workers.map((w) => w.worker.stop()));

    const handled = workers.flatMap((w) =>
      w.logger.lines.filter((l) => l.message === 'pending reference handled').map((l) => String(l.transactionId)),
    );
    const refundIds = refunds.map((r) => r.body.transactionId);
    expect(handled.toSorted()).toEqual(refundIds.toSorted()); // 20, nenhuma repetida
    expect(workers.filter((w) => w.logger.lines.some((l) => l.message === 'pending reference handled')).length).toBeGreaterThan(1);

    expect(await countByStatus(wallet.id, 'PROCESSED')).toBe(41); // OPENING + 20 BETs + 20 REFUNDs
    expect(await walletState(wallet.id)).toMatchObject({ balance: '1000.00' });
    expect(await countLedgerEntries(wallet.id)).toBe(41); // abertura + 20 + 20
    for (const id of refundIds) {
      const processed = (await outboxRows({ aggregateId: id })).filter((e) => e.eventType === 'WagerTransactionProcessed');
      expect(processed).toHaveLength(1);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  'B5. ROLLBACK pendente cuja referência chega REJECTED → REJECTED INVALID_REFERENCE',
  async () => {
    const wallet = await seedWallet('100.00');
    const betId = `bet-${Bun.randomUUIDv7()}`;
    const rollback = await post(reversal(wallet, 'ROLLBACK', '500.00', betId));
    expect(rollback.status).toBe(202);
    const bet = await post(transactionBody(wallet, 'BET', '500.00', { externalTransactionId: betId }));
    expect(bet.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });

    const { useCase } = await worker();
    const resolution = await resolveWhenDue(useCase);

    expect(resolution).toMatchObject({ outcome: 'decided', status: 'REJECTED', failureCode: 'INVALID_REFERENCE' });
    expect(await transactionRow(rollback.body.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'INVALID_REFERENCE',
      reference_transaction_id: null,
    });
    expect((await outboxRows({ aggregateId: rollback.body.transactionId })).at(-1)!.eventType).toBe(
      'WagerTransactionRejected',
    );
    expect(await walletState(wallet.id)).toEqual({ balance: '100.00', version: 1 });
  },
  TEST_TIMEOUT_MS,
);

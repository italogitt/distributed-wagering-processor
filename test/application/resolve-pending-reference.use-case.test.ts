import { beforeEach, describe, expect, test } from 'bun:test';
import { ResolvePendingReferenceUseCase } from '../../src/application/use-cases/resolve-pending-reference.use-case';
import {
  type SubmitTransactionInput,
  SubmitTransactionUseCase,
} from '../../src/application/use-cases/submit-transaction.use-case';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { InMemoryStore, SequentialIds } from './in-memory-store';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const OPENED_AT = new Date('2026-10-29T12:00:00Z');
const HOUR_MS = 3_600_000;

let store: InMemoryStore;
let ids: SequentialIds;
let submit: SubmitTransactionUseCase;

const worker = (ttlMs = HOUR_MS) => new ResolvePendingReferenceUseCase(store, ids, { ttlMs, backoffMaxSeconds: 60 });

const input = (kind: Kind, externalTransactionId: string, overrides: Partial<SubmitTransactionInput> = {}) => ({
  idempotencyKey: `provider-a:${externalTransactionId}`,
  requestId: `req-${externalTransactionId}`,
  providerId: 'provider-a',
  externalTransactionId,
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind,
  money: { amount: '10.00', currency: 'BRL' },
  ...overrides,
});

const row = (transactionId: string) => store.committed.transactions.find((r) => r.transaction.id === transactionId)!;
/** O worker só pega o que venceu: adianta o relógio da linha em vez de esperar. */
const makeDue = (transactionId: string) => {
  row(transactionId).nextAttemptAt = new Date(Date.now() - 1);
};
const balance = () => store.wallet('wallet-1')!.balance.toJSON().amount;
const eventsOf = (transactionId: string) => store.committed.outbox.filter((e) => e.aggregateId === transactionId);

/** REFUND/ROLLBACK que chega antes da referência e fica PENDING_REFERENCE, já vencido. */
async function pendingReversal(kind: Kind, externalId: string, referenceExternalTransactionId: string, amount = '10.00') {
  const result = await submit.execute(
    input(kind, externalId, { referenceExternalTransactionId, money: { amount, currency: 'BRL' } }),
  );
  expect(result.status).toBe(Status.PendingReference);
  makeDue(result.transactionId);
  return result.transactionId;
}

beforeEach(() => {
  store = new InMemoryStore();
  ids = new SequentialIds();
  submit = new SubmitTransactionUseCase(store, ids);
  store.addWallet(
    Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: brl('100.00'),
      version: 1,
      createdAt: OPENED_AT,
      updatedAt: OPENED_AT,
    }),
  );
});

describe('nada a fazer', () => {
  test('sem PENDING_REFERENCE → null', async () => {
    expect(await worker().resolveNext()).toBeNull();
  });

  test('PENDING_REFERENCE ainda não vencida → null', async () => {
    await submit.execute(input(Kind.Refund, 'refund-1', { referenceExternalTransactionId: 'bet-1' }));
    expect(await worker().resolveNext()).toBeNull();
  });
});

describe('referência encontrada → regras normais', () => {
  test('REFUND chega antes da BET; a BET chega → REFUND PROCESSED, crédito e eventos', async () => {
    const refundId = await pendingReversal(Kind.Refund, 'refund-1', 'bet-1');
    const bet = await submit.execute(input(Kind.Bet, 'bet-1'));
    expect(balance()).toBe('90.00');

    const resolution = await worker().resolveNext();

    expect(resolution).toMatchObject({
      transactionId: refundId,
      outcome: 'decided',
      status: Status.Processed,
      attempts: 1,
      correlationId: 'req-refund-1',
    });
    expect(balance()).toBe('100.00');
    expect(row(refundId)).toMatchObject({ attempts: 1, nextAttemptAt: undefined });
    expect(row(refundId).transaction.referenceTransactionId).toBe(bet.transactionId);
    expect(row(refundId).balanceAfter?.toJSON().amount).toBe('100.00');
    // O próprio REFUND pendente ocupa o índice de reversão: ele não conta como "já revertida".
    expect(eventsOf(refundId).map((e) => e.eventType)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);
    const balanceChanged = store.committed.outbox.find(
      (e) => e.eventType === 'WalletBalanceChanged' && e.causationId === refundId,
    );
    // correlationId da requisição original; causationId = a transação, como na entrada.
    expect(balanceChanged).toMatchObject({ correlationId: 'req-refund-1', causationId: refundId });
    expect(eventsOf(refundId)[1]).toMatchObject({ correlationId: 'req-refund-1', causationId: refundId });
  });

  test('ROLLBACK pendente cuja referência chega REJECTED → REJECTED INVALID_REFERENCE + evento', async () => {
    const rollbackId = await pendingReversal(Kind.Rollback, 'rollback-1', 'bet-1');
    const bet = await submit.execute(input(Kind.Bet, 'bet-1', { money: { amount: '500.00', currency: 'BRL' } }));
    expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);

    const resolution = await worker().resolveNext();

    expect(resolution).toMatchObject({
      outcome: 'decided',
      status: Status.Rejected,
      failureCode: FailureCode.InvalidReference,
    });
    expect(balance()).toBe('100.00');
    expect(row(rollbackId).balanceAfter?.toJSON().amount).toBe('100.00');
    expect(eventsOf(rollbackId).map((e) => e.eventType)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
  });

  test('ROLLBACK de WIN sem saldo para devolver → REVERSAL_INSUFFICIENT_FUNDS (mesma regra da entrada)', async () => {
    const rollbackId = await pendingReversal(Kind.Rollback, 'rollback-1', 'win-1', '50.00');
    await submit.execute(input(Kind.Win, 'win-1', { money: { amount: '50.00', currency: 'BRL' } }));
    await submit.execute(input(Kind.Bet, 'bet-2', { money: { amount: '150.00', currency: 'BRL' } }));
    expect(balance()).toBe('0.00');

    const resolution = await worker().resolveNext();

    expect(resolution).toMatchObject({
      transactionId: rollbackId,
      status: Status.Rejected,
      failureCode: FailureCode.ReversalInsufficientFunds,
    });
    expect(balance()).toBe('0.00');
  });
});

describe('referência ainda ausente', () => {
  test('antes do TTL → só attempts e next_attempt_at mudam, com backoff min(2^attempts, 60)', async () => {
    const refundId = await pendingReversal(Kind.Refund, 'refund-1', 'bet-1');
    const before = Date.now();

    const first = await worker().resolveNext();
    expect(first).toMatchObject({ outcome: 'rescheduled', attempts: 1 });
    expect(row(refundId).transaction.status).toBe(Status.PendingReference);
    expect(row(refundId).attempts).toBe(1);
    expect(row(refundId).nextAttemptAt!.getTime() - before).toBeGreaterThanOrEqual(2_000);
    expect(row(refundId).nextAttemptAt!.getTime() - before).toBeLessThan(3_000);

    makeDue(refundId);
    await worker().resolveNext();
    expect(row(refundId).attempts).toBe(2);
    expect(row(refundId).nextAttemptAt!.getTime() - Date.now()).toBeGreaterThan(3_000); // 4 s

    expect(eventsOf(refundId).map((e) => e.eventType)).toEqual(['WagerTransactionPendingReference']);
    expect(balance()).toBe('100.00');
  });

  test('referência também PENDING_REFERENCE (C1) → continua esperando', async () => {
    await submit.execute(input(Kind.Refund, 'refund-0', { referenceExternalTransactionId: 'bet-0' }));
    // ROLLBACK do REFUND, que por sua vez espera a BET.
    const rollbackId = await pendingReversal(Kind.Rollback, 'rollback-1', 'refund-0');

    const resolution = await worker().resolveNext();
    expect(resolution).toMatchObject({ transactionId: rollbackId, outcome: 'rescheduled' });
  });

  test('passou o TTL → REJECTED REFERENCE_NOT_FOUND, saldo atual e WagerTransactionRejected', async () => {
    const refundId = await pendingReversal(Kind.Refund, 'refund-1', 'bet-1');

    const resolution = await worker(0).resolveNext();

    expect(resolution).toMatchObject({
      outcome: 'decided',
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
      attempts: 1,
    });
    expect(row(refundId)).toMatchObject({ attempts: 1, nextAttemptAt: undefined });
    expect(row(refundId).balanceAfter?.toJSON().amount).toBe('100.00');
    expect(eventsOf(refundId).map((e) => e.eventType)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(eventsOf(refundId)[1]).toMatchObject({ correlationId: 'req-refund-1', causationId: refundId });
  });

  test('a referência chega depois do TTL mas antes do worker rodar → aplica normalmente', async () => {
    const refundId = await pendingReversal(Kind.Refund, 'refund-1', 'bet-1');
    await submit.execute(input(Kind.Bet, 'bet-1'));

    const resolution = await worker(0).resolveNext();
    expect(resolution).toMatchObject({ transactionId: refundId, status: Status.Processed });
  });
});

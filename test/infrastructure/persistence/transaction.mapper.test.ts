import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/domain/failure-code';
import { Money } from '../../../src/domain/money';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wager-transaction';
import type { TransactionRecord } from '../../../src/infrastructure/persistence/entities/transaction.record';
import {
  toStoredTransaction,
  toTransactionRow,
} from '../../../src/infrastructure/persistence/mappers/transaction.mapper';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const AT = new Date('2026-10-30T12:00:00Z');

const refund = () =>
  WagerTransaction.create({
    id: 'tx-2',
    providerId: 'provider-a',
    externalTransactionId: 'ext-2',
    idempotencyKey: 'provider-a:ext-2',
    payloadHash: 'hash',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Refund,
    money: brl('10.00'),
    referenceExternalTransactionId: 'ext-1',
    createdAt: AT,
  });

/** O banco devolve as colunas como o INSERT gravou: simula a ida e volta. */
const roundTrip = (row: ReturnType<typeof toTransactionRow>) => toStoredTransaction(row as TransactionRecord);

describe('transaction mapper', () => {
  test('PROCESSED com referência: ida e volta preserva os campos', () => {
    const tx = refund();
    tx.markProcessed('tx-1', AT);
    const row = toTransactionRow({ transaction: tx, balanceAfter: brl('110.00') });

    expect(row).toMatchObject({
      status: 'PROCESSED',
      amount: '10.00',
      currency: 'BRL',
      referenceTransactionId: 'tx-1',
      balanceAfter: '110.00',
      nextAttemptAt: null,
      failureCode: null,
      processedAt: AT,
    });
    const stored = roundTrip(row);
    expect(stored.transaction).toEqual(tx);
    expect(stored.balanceAfter?.equals(brl('110.00'))).toBe(true);
  });

  test('REJECTED: failure_code gravado e devolvido', () => {
    const tx = refund();
    tx.reject(FailureCode.AlreadyReversed);
    const row = toTransactionRow({ transaction: tx, balanceAfter: brl('100.00') });

    expect(row.failureCode).toBe('ALREADY_REVERSED');
    expect(roundTrip(row).transaction.failureCode).toBe(FailureCode.AlreadyReversed);
  });

  test('PENDING_REFERENCE: next_attempt_at gravado, sem balance_after', () => {
    const tx = refund();
    tx.markPendingReference();
    const next = new Date(AT.getTime() + 1_000);
    const row = toTransactionRow({ transaction: tx, nextAttemptAt: next });

    expect(row).toMatchObject({ status: Status.PendingReference, nextAttemptAt: next, balanceAfter: null });
    expect(roundTrip(row).balanceAfter).toBeUndefined();
  });

  test('LOSS: valor 0.00 volta como Money zero', () => {
    const loss = WagerTransaction.create({
      ...refund(),
      id: 'tx-3',
      kind: Kind.Loss,
      money: brl('0.00'),
      referenceExternalTransactionId: undefined,
      createdAt: AT,
    });
    loss.markProcessed(undefined, AT);
    const row = toTransactionRow({ transaction: loss, balanceAfter: brl('50.00') });

    expect(row.amount).toBe('0.00');
    expect(roundTrip(row).transaction.money.isZero()).toBe(true);
  });
});

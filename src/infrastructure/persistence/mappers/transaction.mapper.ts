import type { RequiredEntityData } from '@mikro-orm/core';
import type { InsertTransactionCommand, StoredTransaction } from '../../../application/ports/transaction.repository';
import type { FailureCode } from '../../../domain/failure-code';
import { Money } from '../../../domain/money';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../../domain/wager-transaction';
import type { TransactionRecord } from '../entities/transaction.record';

export function toWagerTransaction(record: TransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId ?? undefined,
    externalTransactionId: record.externalTransactionId ?? undefined,
    idempotencyKey: record.idempotencyKey ?? undefined,
    payloadHash: record.payloadHash ?? undefined,
    roundId: record.roundId ?? undefined,
    gameId: record.gameId ?? undefined,
    walletId: record.walletId,
    playerId: record.playerId,
    // O CHECK do banco garante que kind/status/failure_code estão nas listas do domínio.
    kind: record.kind as WagerTransactionKind,
    status: record.status as WagerTransactionStatus,
    money: Money.from({ amount: record.amount, currency: record.currency }),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: record.processedAt ?? undefined,
    createdAt: record.createdAt,
  });
}

export function toStoredTransaction(record: TransactionRecord): StoredTransaction {
  return {
    transaction: toWagerTransaction(record),
    balanceAfter:
      record.balanceAfter === null ? undefined : Money.from({ amount: record.balanceAfter, currency: record.currency }),
  };
}

export function toTransactionRow(command: InsertTransactionCommand): RequiredEntityData<TransactionRecord> {
  const tx = command.transaction;
  const { amount, currency } = tx.money.toJSON();
  return {
    id: tx.id,
    walletId: tx.walletId,
    playerId: tx.playerId,
    kind: tx.kind,
    status: tx.status,
    amount,
    currency,
    providerId: tx.providerId ?? null,
    externalTransactionId: tx.externalTransactionId ?? null,
    idempotencyKey: tx.idempotencyKey ?? null,
    payloadHash: tx.payloadHash ?? null,
    roundId: tx.roundId ?? null,
    gameId: tx.gameId ?? null,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    failureCode: tx.failureCode ?? null,
    balanceAfter: command.balanceAfter?.toJSON().amount ?? null,
    attempts: 0,
    nextAttemptAt: command.nextAttemptAt ?? null,
    processedAt: tx.processedAt ?? null,
    createdAt: tx.createdAt,
    updatedAt: tx.processedAt ?? tx.createdAt,
  };
}

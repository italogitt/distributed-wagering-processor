import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  InsertTransactionCommand,
  PendingReferenceItem,
  StoredTransaction,
  TransactionRepository,
  UpdateTransactionCommand,
} from '../../../application/ports/transaction.repository';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wager-transaction';
import { TransactionRecord } from '../entities/transaction.record';
import { toStoredTransaction, toTransactionRow, toWagerTransaction } from '../mappers/transaction.mapper';

// Fila do worker (índice parcial transactions_pending_reference_next_attempt_idx).
// SKIP LOCKED: cada worker pega uma linha diferente. Se outro worker resolveu a
// linha entre o snapshot e o lock, o Postgres reavalia o `status` na versão
// nova e a linha sai do resultado: ninguém resolve a mesma transação duas vezes.
const LOCK_NEXT_PENDING_REFERENCE_SQL = `
  select * from transactions
  where status = 'PENDING_REFERENCE' and next_attempt_at <= now()
  order by next_attempt_at
  limit 1
  for update skip locked`;

export class MikroOrmTransactionRepository implements TransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<StoredTransaction | null> {
    const record = await this.em.findOne(
      TransactionRecord,
      { providerId, idempotencyKey },
      { disableIdentityMap: true },
    );
    return record ? toStoredTransaction(record) : null;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(
      TransactionRecord,
      { providerId, externalTransactionId },
      { disableIdentityMap: true },
    );
    return record ? toWagerTransaction(record) : null;
  }

  /** Mesmo filtro do índice parcial `transactions_single_reversal_uq`. */
  async hasActiveReversal(
    providerId: string,
    referenceExternalTransactionId: string,
    excludingTransactionId?: string,
  ): Promise<boolean> {
    const count = await this.em.count(TransactionRecord, {
      providerId,
      referenceExternalTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: { $nin: [WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed] },
      ...(excludingTransactionId ? { id: { $ne: excludingTransactionId } } : {}),
    });
    return count > 0;
  }

  /** INSERT imediato (sem flush). Violação de UNIQUE é traduzida pelo UnitOfWork. */
  async insert(command: InsertTransactionCommand): Promise<void> {
    await this.em.insert(TransactionRecord, toTransactionRow(command));
  }

  async lockNextDuePendingReference(): Promise<PendingReferenceItem | null> {
    const [row] = await this.em.execute(LOCK_NEXT_PENDING_REFERENCE_SQL);
    if (!row) {
      return null;
    }
    const record = this.em.map(TransactionRecord, row, { disableIdentityMap: true });
    return { transaction: toWagerTransaction(record), attempts: record.attempts };
  }

  async reschedulePendingReference(transactionId: string, attempts: number, nextAttemptAt: Date): Promise<void> {
    await this.em.nativeUpdate(TransactionRecord, { id: transactionId }, { attempts, nextAttemptAt });
  }

  /** Os CHECKs da tabela garantem a combinação status/colunas (ex.: next_attempt_at nulo fora de PENDING_REFERENCE). */
  async update(command: UpdateTransactionCommand): Promise<void> {
    const tx = command.transaction;
    await this.em.nativeUpdate(
      TransactionRecord,
      { id: tx.id },
      {
        status: tx.status,
        referenceTransactionId: tx.referenceTransactionId ?? null,
        failureCode: tx.failureCode ?? null,
        balanceAfter: command.balanceAfter.toJSON().amount,
        processedAt: tx.processedAt ?? null,
        attempts: command.attempts,
        nextAttemptAt: null,
        updatedAt: new Date(),
      },
    );
  }
}

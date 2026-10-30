import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  InsertTransactionCommand,
  StoredTransaction,
  TransactionRepository,
} from '../../../application/ports/transaction.repository';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wager-transaction';
import { TransactionRecord } from '../entities/transaction.record';
import { toStoredTransaction, toTransactionRow, toWagerTransaction } from '../mappers/transaction.mapper';

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
  async hasActiveReversal(providerId: string, referenceExternalTransactionId: string): Promise<boolean> {
    const count = await this.em.count(TransactionRecord, {
      providerId,
      referenceExternalTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: { $nin: [WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed] },
    });
    return count > 0;
  }

  /** INSERT imediato (sem flush). Violação de UNIQUE é traduzida pelo UnitOfWork. */
  async insert(command: InsertTransactionCommand): Promise<void> {
    await this.em.insert(TransactionRecord, toTransactionRow(command));
  }
}

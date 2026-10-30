import type { Money } from '../../domain/money';
import type { WagerTransaction } from '../../domain/wager-transaction';

export interface StoredTransaction {
  transaction: WagerTransaction;
  /** Saldo observado na decisão (D12). Só existe em PROCESSED e REJECTED. */
  balanceAfter?: Money;
}

export interface InsertTransactionCommand {
  transaction: WagerTransaction;
  /** Obrigatório em PROCESSED e REJECTED. */
  balanceAfter?: Money;
  /** Obrigatório em PENDING_REFERENCE: quando o worker tenta de novo. */
  nextAttemptAt?: Date;
}

/** Leitura e escrita da tabela `transactions`, na transação SQL corrente. */
export interface TransactionRepository {
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<StoredTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /**
   * Existe REFUND/ROLLBACK desta referência que não esteja REJECTED/FAILED?
   * Mesma regra do índice `transactions_single_reversal_uq` (I6).
   */
  hasActiveReversal(providerId: string, referenceExternalTransactionId: string): Promise<boolean>;
  /** Lança UniqueViolationError se bater num índice único. */
  insert(command: InsertTransactionCommand): Promise<void>;
}

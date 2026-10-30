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

/** Transação PENDING_REFERENCE travada para o worker, com o total de tentativas até agora. */
export interface PendingReferenceItem {
  transaction: WagerTransaction;
  attempts: number;
}

export interface UpdateTransactionCommand {
  /** Já decidida: PROCESSED ou REJECTED. */
  transaction: WagerTransaction;
  balanceAfter: Money;
  attempts: number;
}

/** Leitura e escrita da tabela `transactions`, na transação SQL corrente. */
export interface TransactionRepository {
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<StoredTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /**
   * Existe REFUND/ROLLBACK desta referência que não esteja REJECTED/FAILED,
   * fora `excludingTransactionId`? Mesma regra do índice
   * `transactions_single_reversal_uq` (I6).
   */
  hasActiveReversal(
    providerId: string,
    referenceExternalTransactionId: string,
    excludingTransactionId?: string,
  ): Promise<boolean>;
  /** Lança UniqueViolationError se bater num índice único. */
  insert(command: InsertTransactionCommand): Promise<void>;

  /**
   * Trava (até o fim da transação SQL) a próxima PENDING_REFERENCE com a
   * tentativa vencida, pulando as que outro worker já travou. `null` se não há.
   */
  lockNextDuePendingReference(): Promise<PendingReferenceItem | null>;
  /** Referência ainda ausente: só tentativas e próxima tentativa mudam (status igual). */
  reschedulePendingReference(transactionId: string, attempts: number, nextAttemptAt: Date): Promise<void>;
  /** Grava a decisão de uma PENDING_REFERENCE (PROCESSED ou REJECTED). */
  update(command: UpdateTransactionCommand): Promise<void>;
}

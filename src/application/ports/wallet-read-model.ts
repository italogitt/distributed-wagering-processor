import type { MoneyProps } from '../../domain/money';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/** Posição de um lançamento na ordem do extrato: (createdAt, id). */
export interface LedgerPosition {
  /** Timestamp exato do banco (microssegundos), como texto ISO-8601 UTC. */
  createdAt: string;
  id: string;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
  position: LedgerPosition;
}

export interface TransactionView {
  transactionId: string;
  providerId?: string;
  externalTransactionId?: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: string;
  status: string;
  money: MoneyProps;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  /** Saldo observado na decisão; ausente em PENDING_REFERENCE. */
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

/** Saldo guardado e soma do ledger lidos no MESMO snapshot. */
export interface ReconciliationSnapshot {
  storedBalance: MoneyProps;
  /** Créditos - débitos. */
  ledgerSum: MoneyProps;
  checkedEntries: number;
}

/**
 * Leituras sem regra de negócio (seção 9). Fora da UnitOfWork: não travam
 * nada e não participam de transação de escrita. Id fora do formato → `null`.
 */
export interface WalletReadModel {
  findWallet(walletId: string): Promise<WalletView | null>;
  /** Até `limit` lançamentos depois de `after`, na ordem (createdAt, id). */
  ledgerPage(walletId: string, after: LedgerPosition | undefined, limit: number): Promise<LedgerEntryView[]>;
  findTransaction(transactionId: string): Promise<TransactionView | null>;
  findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView | null>;
  reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | null>;
}

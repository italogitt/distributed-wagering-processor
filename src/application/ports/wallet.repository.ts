import type { Money } from '../../domain/money';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export interface ApplyMovementCommand {
  walletId: string;
  money: Money;
  transactionId: string;
  /** Id do lançamento, gerado pelo caso de uso (UUIDv7). */
  entryId: string;
  at: Date;
}

export interface MovementApplied {
  status: 'APPLIED';
  /** Estado da wallet depois do movimento. */
  wallet: Wallet;
  entry: WalletLedgerEntry;
}

// TODO: trocar por um failureCode quando a taxonomia de falhas for definida.
export interface InsufficientBalance {
  status: 'INSUFFICIENT_BALANCE';
}

export interface CreateWalletCommand {
  wallet: Wallet;
  /** Lançamento CREDIT da abertura; `null` com saldo inicial 0. */
  openingEntry: WalletLedgerEntry | null;
}

export type ApplyDebitResult = MovementApplied | InsufficientBalance;
export type ApplyCreditResult = MovementApplied;

/**
 * Porta do saldo. `findById` só lê. `applyDebit`/`applyCredit` fazem, na
 * transação SQL corrente:
 *
 * 1. `UPDATE wallets SET balance = balance ∓ :valor, version = version + 1 ...
 *    WHERE id = :id [AND balance >= :valor] RETURNING *` (D10);
 * 2. se afetou 1 linha, reidrata a `Wallet` com o estado DE ANTES
 *    (saldo devolvido ± valor, version devolvida - 1) e chama `debit`/`credit`,
 *    que produz o lançamento já validado;
 * 3. grava o lançamento no ledger.
 *
 * O saldo insuficiente é detectado pelo UPDATE (0 linhas), não pela `Wallet`.
 * Por isso ele volta como resultado, e não como exceção.
 */
export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  /** Grava a wallet e o lançamento de abertura. Lança UniqueViolationError se o player já tem wallet na moeda. */
  create(command: CreateWalletCommand): Promise<void>;
  applyDebit(command: ApplyMovementCommand): Promise<ApplyDebitResult>;
  applyCredit(command: ApplyMovementCommand): Promise<ApplyCreditResult>;
}

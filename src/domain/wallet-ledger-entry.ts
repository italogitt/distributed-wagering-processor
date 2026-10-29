import { CurrencyMismatchError, InvalidLedgerEntryError } from './errors';
import type { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * Lançamento do ledger. Imutável por estrutura: todos os campos são readonly
 * e não existe método que altere o objeto. O banco reforça isso com triggers
 * que recusam UPDATE/DELETE/TRUNCATE (D13).
 *
 * `money` é sempre positivo; o sentido vem de `direction`.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  /** Valida o lançamento. Mesmas regras dos CHECKs de `ledger_entries`. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;

    for (const other of [balanceBefore, balanceAfter]) {
      if (other.currency !== money.currency) {
        throw new CurrencyMismatchError(money.currency, other.currency);
      }
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError(`Valor do lançamento deve ser > 0, recebido ${money}`);
    }
    if (balanceBefore.isNegative()) {
      throw new InvalidLedgerEntryError(`Saldo anterior negativo: ${balanceBefore}`);
    }
    if (balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError(`Saldo posterior negativo: ${balanceAfter}`);
    }

    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      const sign = props.direction === LedgerDirection.Credit ? '+' : '-';
      throw new InvalidLedgerEntryError(
        `Lançamento desbalanceado: ${balanceBefore} ${sign} ${money} ≠ ${balanceAfter}`,
      );
    }
    return entry;
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter (+ para CREDIT, - para DEBIT). */
  isBalanced(): boolean {
    // É uma pergunta: moedas diferentes respondem `false` em vez de lançar.
    if (
      this.balanceBefore.currency !== this.money.currency ||
      this.balanceAfter.currency !== this.money.currency
    ) {
      return false;
    }
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}

import { CurrencyMismatchError, InsufficientBalanceError, InvalidWalletError } from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  /** A moeda da wallet é a moeda deste valor. */
  initialBalance: Money;
  openingTransactionId: string;
  /** Usado só se `initialBalance > 0`. */
  openingEntryId: string;
  at: Date;
}

export interface OpenWalletResult {
  wallet: Wallet;
  /** `null` quando o saldo inicial é 0: sem movimento, sem lançamento. */
  openingEntry: WalletLedgerEntry | null;
}

export interface MovementProps {
  /** Id do lançamento, gerado por quem chama (UUIDv7, como o id da wallet). */
  entryId: string;
  money: Money;
  transactionId: string;
  at: Date;
}

/**
 * Aggregate root da carteira. Saldo, versão e `updatedAt` só mudam por
 * `debit`/`credit`, que sempre devolvem o lançamento correspondente: assim
 * toda mudança de saldo tem um lançamento no ledger.
 *
 * A concorrência não é resolvida aqui. O banco faz o UPDATE condicional
 * (D10), e a Wallet reidratada com o estado de antes refaz a mesma conta para
 * produzir o lançamento validado.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet com `version = 1` e o saldo inicial já aplicado. Não chama
   * `credit()`, que subiria a versão para 2. Se o saldo inicial for > 0,
   * devolve o lançamento CREDIT 0 → saldo inicial.
   */
  static open(props: OpenWalletProps): OpenWalletResult {
    const { initialBalance } = props;
    if (props.playerId.trim().length === 0) {
      throw new InvalidWalletError('playerId não pode ser vazio');
    }
    // Money.from() já barra negativos, mas um Money vindo de subtract() pode ser.
    if (initialBalance.isNegative()) {
      throw new InvalidWalletError(`Saldo inicial negativo: ${initialBalance}`);
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      props.at,
      props.at,
    );

    const openingEntry = initialBalance.isZero()
      ? null
      : WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: wallet.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(initialBalance.currency),
          balanceAfter: initialBalance,
          createdAt: props.at,
        });

    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    const after = this._balance.subtract(props.money);
    if (after.isNegative()) {
      throw new InsufficientBalanceError(
        this._balance.toJSON().amount,
        props.money.toJSON().amount,
      );
    }
    return this.apply(LedgerDirection.Debit, after, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(props.money), props);
  }

  /**
   * Cria o lançamento ANTES de mudar o estado: se ele for inválido (ex.:
   * valor 0), `create()` lança e a wallet fica intacta.
   */
  private apply(direction: LedgerDirection, after: Money, props: MovementProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter: after,
      createdAt: props.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = props.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}

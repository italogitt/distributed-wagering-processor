import { DomainError } from '../../domain/errors';
import { Money, type MoneyProps } from '../../domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { InvalidInputError, UniqueViolationError, WalletAlreadyExistsError } from '../errors';
import { WalletBalanceChanged } from '../events';
import type { IdGenerator } from '../ports/id-generator';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { WalletView } from '../ports/wallet-read-model';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
  /** Vira o correlationId do evento. */
  requestId: string;
}

const PLAYER_CURRENCY_UNIQUE = 'wallets_player_id_currency_uq';

/**
 * POST /wallets (seção 9). Numa única transação SQL: a wallet e, se o saldo
 * inicial for > 0, a transação interna OPENING (PROCESSED), o lançamento
 * CREDIT e o WalletBalanceChanged na outbox. Saldo 0 → só a wallet.
 */
export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: CreateWalletInput): Promise<WalletView> {
    const now = new Date();
    const { wallet, openingEntry, opening } = this.open(input, now);

    try {
      await this.uow.run(async (repos) => {
        await repos.wallets.create({ wallet, openingEntry });
        if (opening && openingEntry) {
          await repos.transactions.insert({ transaction: opening, balanceAfter: wallet.balance });
          await repos.outbox.add([
            WalletBalanceChanged.from(wallet, openingEntry, {
              eventId: this.ids.next(),
              correlationId: input.requestId,
              causationId: opening.id,
              occurredAt: now,
            }),
          ]);
        }
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === PLAYER_CURRENCY_UNIQUE) {
        throw new WalletAlreadyExistsError(`Player ${wallet.playerId} já tem wallet em ${wallet.currency}`);
      }
      throw error;
    }

    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  /** Validação no domínio, antes de abrir a transação SQL. Erro de domínio aqui é payload inválido (400). */
  private open(input: CreateWalletInput, now: Date) {
    try {
      const initialBalance = Money.from(input.initialBalance);
      const walletId = this.ids.next();
      const openingTransactionId = this.ids.next();
      const { wallet, openingEntry } = Wallet.open({
        id: walletId,
        playerId: input.playerId,
        initialBalance,
        openingTransactionId,
        openingEntryId: this.ids.next(),
        at: now,
      });
      if (!openingEntry) {
        return { wallet, openingEntry, opening: null };
      }
      const opening = WagerTransaction.create({
        id: openingTransactionId,
        walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Opening,
        money: initialBalance,
        createdAt: now,
      });
      opening.markProcessed(undefined, now);
      return { wallet, openingEntry, opening };
    } catch (error) {
      if (error instanceof DomainError) {
        throw new InvalidInputError(error.message);
      }
      throw error;
    }
  }
}

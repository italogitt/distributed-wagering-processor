import { InvalidInputError, TransactionNotFoundError, WalletNotFoundError } from '../errors';
import { decodeLedgerCursor, encodeLedgerCursor } from '../ledger-cursor';
import type { LedgerEntryView, TransactionView, WalletReadModel, WalletView } from '../ports/wallet-read-model';

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 100;

export interface LedgerQuery {
  walletId: string;
  cursor?: string;
  limit?: number;
}

export interface LedgerPage {
  walletId: string;
  items: Array<Omit<LedgerEntryView, 'position'>>;
  /** `null` na última página. */
  nextCursor: string | null;
}

/** Consultas da seção 9: só leitura, 404 quando não existe. */
export class WalletQueries {
  constructor(private readonly readModel: WalletReadModel) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.readModel.findWallet(walletId);
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }

  /**
   * Extrato por keyset em (createdAt, id), nunca OFFSET: um lançamento novo
   * entre uma página e outra não desloca as seguintes (sem repetição nem buraco).
   */
  async getLedger(query: LedgerQuery): Promise<LedgerPage> {
    const limit = query.limit ?? LEDGER_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_MAX_LIMIT) {
      throw new InvalidInputError(`limit deve ser um inteiro entre 1 e ${LEDGER_MAX_LIMIT}`);
    }
    const after = query.cursor === undefined ? undefined : decodeLedgerCursor(query.cursor, query.walletId);
    await this.getWallet(query.walletId);

    // Um a mais para saber se existe próxima página.
    const rows = await this.readModel.ledgerPage(query.walletId, after, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      walletId: query.walletId,
      items: page.map(({ position, ...item }) => item),
      nextCursor: rows.length > limit && last ? encodeLedgerCursor(query.walletId, last.position) : null,
    };
  }

  async getTransaction(transactionId: string): Promise<TransactionView> {
    const transaction = await this.readModel.findTransaction(transactionId);
    if (!transaction) throw new TransactionNotFoundError(`Transação ${transactionId} não existe`);
    return transaction;
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const transaction = await this.readModel.findTransactionByExternalId(providerId, externalTransactionId);
    if (!transaction) {
      throw new TransactionNotFoundError(`Transação ${externalTransactionId} do provedor ${providerId} não existe`);
    }
    return transaction;
  }
}

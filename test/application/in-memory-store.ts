import { UniqueViolationError } from '../../src/application/errors';
import type { IntegrationEvent } from '../../src/application/events';
import type { IdGenerator } from '../../src/application/ports/id-generator';
import type { InsertTransactionCommand, StoredTransaction } from '../../src/application/ports/transaction.repository';
import type { TransactionalRepositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import type {
  ApplyCreditResult,
  ApplyDebitResult,
  ApplyMovementCommand,
} from '../../src/application/ports/wallet.repository';
import type { Money } from '../../src/domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { Wallet, type WalletState } from '../../src/domain/wallet';
import type { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';

export interface TransactionRow extends InsertTransactionCommand {}

interface State {
  wallets: Map<string, WalletState>;
  transactions: TransactionRow[];
  ledger: WalletLedgerEntry[];
  outbox: IntegrationEvent<unknown>[];
}

const clone = (state: State): State => ({
  wallets: new Map([...state.wallets].map(([id, wallet]) => [id, { ...wallet }])),
  transactions: [...state.transactions],
  ledger: [...state.ledger],
  outbox: [...state.outbox],
});

const toState = (wallet: Wallet): WalletState => ({
  id: wallet.id,
  playerId: wallet.playerId,
  currency: wallet.currency,
  balance: wallet.balance,
  version: wallet.version,
  createdAt: wallet.createdAt,
  updatedAt: wallet.updatedAt,
});

const isActiveReversal = (row: TransactionRow) =>
  (row.transaction.kind === WagerTransactionKind.Refund || row.transaction.kind === WagerTransactionKind.Rollback) &&
  row.transaction.status !== WagerTransactionStatus.Rejected &&
  row.transaction.status !== WagerTransactionStatus.Failed;

/**
 * Banco falso para testes unitários do caso de uso. Cada `run` trabalha numa
 * cópia do estado confirmado: se o callback lança, a cópia é descartada
 * (rollback). As leituras de `transactions` e os índices únicos enxergam a
 * cópia E o confirmado, como o Postgres em READ COMMITTED enxerga linhas que
 * outras transações commitaram depois que a nossa começou.
 */
export class InMemoryStore implements UnitOfWork {
  committed: State = { wallets: new Map(), transactions: [], ledger: [], outbox: [] };
  runs = 0;
  /** Chamado antes de cada insert; simula outra requisição commitando no meio. */
  beforeInsert?: (store: InMemoryStore) => void;
  /** Chamado antes de cada findByExternalId; mesma ideia, entre as leituras do passo 3. */
  beforeFindByExternalId?: (store: InMemoryStore) => void;

  addWallet(wallet: Wallet): void {
    this.committed.wallets.set(wallet.id, toState(wallet));
  }

  addTransaction(row: TransactionRow): void {
    this.committed.transactions.push(row);
  }

  wallet(id: string): WalletState | undefined {
    return this.committed.wallets.get(id);
  }

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    this.runs += 1;
    const working = clone(this.committed);
    const result = await work(this.repositories(working));
    this.committed = working;
    return result;
  }

  private repositories(working: State): TransactionalRepositories {
    const findWallet = (id: string) => working.wallets.get(id);
    const allRows = () => [...working.transactions, ...this.committed.transactions.filter((r) => !working.transactions.includes(r))];

    const move = (command: ApplyMovementCommand, debit: boolean) => {
      const before = Wallet.rehydrate(findWallet(command.walletId)!);
      const props = { entryId: command.entryId, money: command.money, transactionId: command.transactionId, at: command.at };
      const entry = debit ? before.debit(props) : before.credit(props);
      working.wallets.set(before.id, toState(before));
      working.ledger.push(entry);
      return { status: 'APPLIED' as const, wallet: before, entry };
    };

    return {
      wallets: {
        findById: async (id) => {
          const state = findWallet(id);
          return state ? Wallet.rehydrate(state) : null;
        },
        applyDebit: async (command): Promise<ApplyDebitResult> => {
          const balance: Money = findWallet(command.walletId)!.balance;
          if (balance.isLessThan(command.money)) {
            return { status: 'INSUFFICIENT_BALANCE' };
          }
          return move(command, true);
        },
        applyCredit: async (command): Promise<ApplyCreditResult> => move(command, false),
      },
      transactions: {
        findByIdempotencyKey: async (providerId, key): Promise<StoredTransaction | null> => {
          const row = allRows().find(
            (r) => r.transaction.providerId === providerId && r.transaction.idempotencyKey === key,
          );
          return row ? { transaction: row.transaction, balanceAfter: row.balanceAfter } : null;
        },
        findByExternalId: async (providerId, externalId) => {
          this.beforeFindByExternalId?.(this);
          return (
            allRows().find(
              (r) => r.transaction.providerId === providerId && r.transaction.externalTransactionId === externalId,
            )?.transaction ?? null
          );
        },
        hasActiveReversal: async (providerId, referenceExternalId) =>
          allRows().some(
            (r) =>
              isActiveReversal(r) &&
              r.transaction.providerId === providerId &&
              r.transaction.referenceExternalTransactionId === referenceExternalId,
          ),
        insert: async (command) => {
          this.beforeInsert?.(this);
          const tx = command.transaction;
          for (const row of allRows()) {
            const other = row.transaction;
            if (other.providerId !== tx.providerId) continue;
            if (other.idempotencyKey === tx.idempotencyKey) {
              throw new UniqueViolationError('transactions_provider_idempotency_key_uq');
            }
            if (other.externalTransactionId === tx.externalTransactionId) {
              throw new UniqueViolationError('transactions_provider_external_id_uq');
            }
            if (
              isActiveReversal(row) &&
              isActiveReversal(command) &&
              other.referenceExternalTransactionId === tx.referenceExternalTransactionId
            ) {
              throw new UniqueViolationError('transactions_single_reversal_uq');
            }
          }
          working.transactions.push(command);
        },
      },
      outbox: {
        add: async (events) => {
          working.outbox.push(...events);
        },
      },
    };
  }
}

export class SequentialIds implements IdGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    return `id-${this.counter}`;
  }
}

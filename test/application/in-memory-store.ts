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
  inbox: string[];
  wallets: Map<string, WalletState>;
  transactions: TransactionRow[];
  ledger: WalletLedgerEntry[];
  outbox: IntegrationEvent<unknown>[];
}

const emptyState = (): State => ({ inbox: [], wallets: new Map(), transactions: [], ledger: [], outbox: [] });
const inboxKey = (consumer: string, messageId: string) => `${consumer}|${messageId}`;

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
 * Banco falso para testes unitários do caso de uso. Cada `run` guarda só as
 * próprias escritas (`working`): se o callback lança, elas são descartadas
 * (rollback); se termina, são mescladas no confirmado (commit). As leituras
 * enxergam as escritas da própria transação E o confirmado do momento, como
 * o Postgres em READ COMMITTED enxerga o que outras transações commitaram
 * depois que a nossa começou (os hooks simulam esses commits).
 */
export class InMemoryStore implements UnitOfWork {
  committed: State = emptyState();
  runs = 0;
  /** Chamado antes de cada insert; simula outra requisição commitando no meio. */
  beforeInsert?: (store: InMemoryStore) => void;
  /** Chamado antes de cada findByExternalId; mesma ideia, entre as leituras do passo 3. */
  beforeFindByExternalId?: (store: InMemoryStore) => void;
  /** Chamado antes de cada hasActiveReversal; simula a reversão vencedora commitando entre os passos 4 e 6. */
  beforeHasActiveReversal?: (store: InMemoryStore) => void;
  /** Chamado antes de cada inbox.add; simula a mesma mensagem commitando em outro consumer. */
  beforeInboxAdd?: (store: InMemoryStore) => void;

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
    const working = emptyState();
    const result = await work(this.repositories(working));
    for (const [id, wallet] of working.wallets) this.committed.wallets.set(id, wallet);
    this.committed.transactions.push(...working.transactions);
    this.committed.ledger.push(...working.ledger);
    this.committed.outbox.push(...working.outbox);
    this.committed.inbox.push(...working.inbox);
    return result;
  }

  private repositories(working: State): TransactionalRepositories {
    const findWallet = (id: string) => working.wallets.get(id) ?? this.committed.wallets.get(id);
    const allRows = () => [...this.committed.transactions, ...working.transactions];

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
        hasActiveReversal: async (providerId, referenceExternalId) => {
          this.beforeHasActiveReversal?.(this);
          return allRows().some(
            (r) =>
              isActiveReversal(r) &&
              r.transaction.providerId === providerId &&
              r.transaction.referenceExternalTransactionId === referenceExternalId,
          );
        },
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
      inbox: {
        exists: async (consumer, messageId) => {
          const key = inboxKey(consumer, messageId);
          return this.committed.inbox.includes(key) || working.inbox.includes(key);
        },
        add: async (consumer, messageId) => {
          this.beforeInboxAdd?.(this);
          const key = inboxKey(consumer, messageId);
          if (this.committed.inbox.includes(key) || working.inbox.includes(key)) {
            throw new UniqueViolationError('inbox_messages_consumer_message_id_uq');
          }
          working.inbox.push(key);
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

import type { InboxRepository } from './inbox.repository';
import type { OutboxRepository } from './outbox.repository';
import type { TransactionRepository } from './transaction.repository';
import type { WalletRepository } from './wallet.repository';

/** Repositórios ligados a uma mesma transação SQL. */
export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: TransactionRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

export interface UnitOfWork {
  /**
   * Roda `work` numa transação SQL: commit se terminar, rollback se lançar.
   * Os repositórios chegam como argumento, então fica explícito o que roda
   * dentro da transação. Violação de UNIQUE (inclusive no commit) sobe como
   * UniqueViolationError; falha transitória de infraestrutura (conexão,
   * timeout, deadlock) sobe como TransientInfrastructureError.
   */
  run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
}

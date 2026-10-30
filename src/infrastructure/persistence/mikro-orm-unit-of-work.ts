import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { TransientInfrastructureError, UniqueViolationError } from '../../application/errors';
import type { TransactionalRepositories, UnitOfWork } from '../../application/ports/unit-of-work';
import { MikroOrmInboxRepository } from './repositories/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from './repositories/mikro-orm-outbox.repository';
import { MikroOrmTransactionRepository } from './repositories/mikro-orm-transaction.repository';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository';
import { isTransientDatabaseError } from './transient-error';

/**
 * Cada `run` abre uma transação SQL num EntityManager novo (`fork`), então
 * duas requisições nunca compartilham estado. Isolamento READ COMMITTED (o
 * padrão do Postgres): a concorrência é resolvida pelo UPDATE condicional e
 * pelos índices únicos, não pelo nível de isolamento.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly em: EntityManager) {}

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.em.fork().transactional((em) =>
        work({
          wallets: new MikroOrmWalletRepository(em),
          transactions: new MikroOrmTransactionRepository(em),
          outbox: new MikroOrmOutboxRepository(em),
          inbox: new MikroOrmInboxRepository(em),
        }),
      );
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        // O DriverException copia os campos do erro do `pg`, incluindo `constraint`.
        const { constraint } = error as UniqueConstraintViolationException & { constraint?: string };
        throw new UniqueViolationError(constraint ?? 'desconhecida');
      }
      if (isTransientDatabaseError(error)) {
        throw new TransientInfrastructureError('Falha transitória no banco', { cause: error });
      }
      throw error;
    }
  }
}

import { UniqueViolationError } from '../../application/errors';
import type { TransactionalRepositories, UnitOfWork } from '../../application/ports/unit-of-work';
import type { Metrics } from './metrics';

/**
 * Conta as UniqueViolation que saem da transação SQL, sem tocar no caso de
 * uso: cada uma é uma corrida perdida para outra requisição (mesma key, mesma
 * reversão, mesma mensagem na inbox) e dispara o retry único do caso de uso.
 */
export class MeteredUnitOfWork implements UnitOfWork {
  constructor(
    private readonly inner: UnitOfWork,
    private readonly metrics: Metrics,
  ) {}

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.inner.run(work);
    } catch (error) {
      if (error instanceof UniqueViolationError) {
        this.metrics.uniqueViolation();
      }
      throw error;
    }
  }
}

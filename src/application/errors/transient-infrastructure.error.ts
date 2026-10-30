/**
 * A infraestrutura traduz falhas que podem passar sozinhas (conexão com o
 * banco, timeout, deadlock) para este erro. Quem chamou decide tentar de novo
 * mais tarde; o caso de uso não conhece o driver.
 */
export class TransientInfrastructureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientInfrastructureError';
  }
}

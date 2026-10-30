/**
 * A infraestrutura traduz a violação de UNIQUE do Postgres para este erro.
 * Assim o caso de uso decide o retry sem conhecer o driver do banco.
 */
export class UniqueViolationError extends Error {
  constructor(public readonly constraint: string) {
    super(`Violação de UNIQUE: ${constraint}`);
    this.name = 'UniqueViolationError';
  }
}

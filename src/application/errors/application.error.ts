/**
 * Base dos erros que o caso de uso devolve para quem chamou (API ou fila).
 * Cada subclasse vira um status HTTP distinto no controller.
 */
export abstract class ApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

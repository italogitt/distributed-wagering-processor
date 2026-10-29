/**
 * Base de todos os erros de regra de negócio. Não depende de framework:
 * a camada de interfaces decide como traduzir cada subclasse (ex.: HTTP 4xx).
 */
export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    // `new.target` é a subclasse concreta, então `name` vira
    // "InvalidMoneyError", "CurrencyMismatchError" etc. nos logs.
    this.name = new.target.name;
  }
}

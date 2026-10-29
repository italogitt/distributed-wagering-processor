import { DomainError } from './domain.error';

/** Operação entre dois `Money` de moedas diferentes. */
export class CurrencyMismatchError extends DomainError {
  constructor(
    public readonly left: string,
    public readonly right: string,
  ) {
    super(`Operação entre moedas diferentes: ${left} e ${right}`);
  }
}

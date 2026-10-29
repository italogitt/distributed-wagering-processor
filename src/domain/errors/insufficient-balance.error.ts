import { DomainError } from './domain.error';

/**
 * Débito que deixaria o saldo negativo.
 *
 * No fluxo normal isso não acontece: o UPDATE condicional do banco
 * (`WHERE balance >= valor`) recusa antes, e a porta devolve
 * "saldo insuficiente" como resultado. Se este erro aparecer, é bug
 * (estado reidratado errado), não caminho de negócio.
 */
export class InsufficientBalanceError extends DomainError {
  constructor(
    public readonly balance: string,
    public readonly requested: string,
  ) {
    super(`Saldo insuficiente: saldo ${balance}, débito de ${requested}`);
  }
}

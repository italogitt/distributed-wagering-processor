import { DomainError } from './domain.error';

/** Dados inválidos para criar uma transação (valor, referência ou campos de provedor por kind). */
export class InvalidWagerTransactionError extends DomainError {}

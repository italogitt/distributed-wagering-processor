import { DomainError } from './domain.error';

/**
 * Operação não permitida no estado ou kind atual da transação (ex.: rejeitar
 * uma transação já PROCESSED). É erro de programação, não caminho de negócio:
 * o caso de uso deveria ter evitado a chamada.
 */
export class InvalidTransactionStateError extends DomainError {}

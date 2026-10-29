import { DomainError } from './domain.error';

/** Entrada de `Money` rejeitada (valor ou moeda). A mensagem diz o motivo. */
export class InvalidMoneyError extends DomainError {}

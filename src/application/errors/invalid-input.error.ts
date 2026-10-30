import { ApplicationError } from './application.error';

/** Payload inválido (kind, valor, moeda, referência). HTTP 400. */
export class InvalidInputError extends ApplicationError {}

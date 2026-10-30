import { ApplicationError } from './application.error';

/**
 * Mesma idempotencyKey com payload diferente, ou mesmo externalTransactionId
 * com outra key. É conflito, não replay. HTTP 409.
 */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

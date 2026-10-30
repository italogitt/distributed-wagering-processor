import { InvalidInputError } from '../../application/errors';
import type { SubmitTransactionInput } from '../../application/use-cases/submit-transaction.use-case';
import { parseSubmitTransactionRequest } from '../http/submit-transaction.http';

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

export interface WagerMessage {
  /** Id de negócio da mensagem (D16): chave da inbox e correlationId. */
  messageId: string;
  input: SubmitTransactionInput;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Corpo da mensagem (seção 10) → input do caso de uso. Qualquer problema de
 * forma é InvalidInputError: mensagem permanente, que vai para a DLQ.
 */
export function parseWagerMessage(body: string | undefined): WagerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? '');
  } catch {
    throw new InvalidInputError('Corpo da mensagem não é JSON válido');
  }
  if (!isRecord(parsed)) {
    throw new InvalidInputError('Corpo da mensagem deve ser um objeto JSON');
  }
  const { messageId, type, data } = parsed;
  if (typeof messageId !== 'string' || messageId.trim().length === 0) {
    throw new InvalidInputError('messageId é obrigatório');
  }
  if (type !== WAGER_TRANSACTION_REQUESTED) {
    throw new InvalidInputError(`type desconhecido: ${String(type)}`);
  }
  if (!isRecord(data)) {
    throw new InvalidInputError('data deve ser um objeto');
  }
  const { idempotencyKey } = data;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    throw new InvalidInputError('data.idempotencyKey é obrigatório');
  }
  // Mesma validação de forma da entrada HTTP; a key vem no corpo, não num header.
  const input = parseSubmitTransactionRequest({ idempotencyKey, requestId: messageId }, data);
  return { messageId, input };
}

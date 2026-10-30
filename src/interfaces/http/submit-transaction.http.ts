import { InvalidInputError } from '../../application/errors';
import type {
  SubmitTransactionInput,
  SubmitTransactionOutput,
} from '../../application/use-cases/submit-transaction.use-case';
import type { FailureCode } from '../../domain/failure-code';
import type { MoneyProps } from '../../domain/money';
import { WagerTransactionStatus } from '../../domain/wager-transaction';

export interface SubmitTransactionHeaders {
  idempotencyKey: string | undefined;
  requestId: string;
}

/** Corpo da resposta. `balance` é o nome do README; no caso de uso é `balanceAfter`. */
export interface SubmitTransactionResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balance?: MoneyProps;
  idempotentReplay: boolean;
}

const REQUIRED_FIELDS = [
  'providerId',
  'externalTransactionId',
  'walletId',
  'playerId',
  'roundId',
  'gameId',
  'kind',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFilledString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/**
 * Só confere a forma (campos presentes, strings não vazias). Kind, valor e
 * moeda são validados pelo caso de uso, que também atende a fila SQS.
 */
export function parseSubmitTransactionRequest(
  headers: SubmitTransactionHeaders,
  body: unknown,
): SubmitTransactionInput {
  if (!isFilledString(headers.idempotencyKey)) {
    throw new InvalidInputError('Header Idempotency-Key é obrigatório');
  }
  if (!isRecord(body)) {
    throw new InvalidInputError('Corpo deve ser um objeto JSON');
  }
  for (const field of REQUIRED_FIELDS) {
    if (!isFilledString(body[field])) {
      throw new InvalidInputError(`${field} é obrigatório e deve ser uma string não vazia`);
    }
  }
  const { money, referenceExternalTransactionId } = body;
  if (!isRecord(money) || typeof money.amount !== 'string' || typeof money.currency !== 'string') {
    throw new InvalidInputError('money deve ser { amount: string, currency: string }');
  }
  if (referenceExternalTransactionId !== undefined && !isFilledString(referenceExternalTransactionId)) {
    throw new InvalidInputError('referenceExternalTransactionId, quando enviado, deve ser uma string não vazia');
  }

  return {
    idempotencyKey: headers.idempotencyKey,
    requestId: headers.requestId,
    providerId: body.providerId as string,
    externalTransactionId: body.externalTransactionId as string,
    walletId: body.walletId as string,
    playerId: body.playerId as string,
    roundId: body.roundId as string,
    gameId: body.gameId as string,
    kind: body.kind as string,
    money: { amount: money.amount, currency: money.currency },
    referenceExternalTransactionId,
  };
}

/** PROCESSED e REJECTED: 200 (a decisão foi tomada). PENDING_REFERENCE: 202 (aceita, decisão depois). */
export function httpStatusFor(output: SubmitTransactionOutput): number {
  return output.status === WagerTransactionStatus.PendingReference ? 202 : 200;
}

export function toSubmitTransactionResponse(output: SubmitTransactionOutput): SubmitTransactionResponse {
  return {
    transactionId: output.transactionId,
    status: output.status,
    failureCode: output.failureCode,
    balance: output.balanceAfter,
    idempotentReplay: output.idempotentReplay,
  };
}

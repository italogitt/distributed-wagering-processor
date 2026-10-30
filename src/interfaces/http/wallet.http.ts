import { InvalidInputError } from '../../application/errors';
import type { CreateWalletInput } from '../../application/use-cases/create-wallet.use-case';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Só a forma do corpo; valor e moeda são validados pelo domínio no caso de uso. */
export function parseCreateWalletRequest(requestId: string, body: unknown): CreateWalletInput {
  if (!isRecord(body)) {
    throw new InvalidInputError('Corpo deve ser um objeto JSON');
  }
  const { playerId, initialBalance } = body;
  if (typeof playerId !== 'string' || playerId.trim().length === 0) {
    throw new InvalidInputError('playerId é obrigatório e deve ser uma string não vazia');
  }
  if (!isRecord(initialBalance) || typeof initialBalance.amount !== 'string' || typeof initialBalance.currency !== 'string') {
    throw new InvalidInputError('initialBalance deve ser { amount: string, currency: string }');
  }
  return { playerId, initialBalance: { amount: initialBalance.amount, currency: initialBalance.currency }, requestId };
}

/** `limit` da query string. Ausente → default do caso de uso; o intervalo também é validado lá. */
export function parseLimit(limit: string | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!/^\d+$/.test(limit)) {
    throw new InvalidInputError('limit deve ser um inteiro positivo');
  }
  return Number(limit);
}

import { createHash } from 'node:crypto';

/** Campos de negócio que entram no hash. Header e metadados de transporte não entram. */
export interface PayloadHashFields {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string;
}

/**
 * SHA-256 (hex) de um JSON canônico: chaves em ordem alfabética, sem espaços,
 * referência ausente como `null`. Com uma única forma de escrever cada payload,
 * o mesmo pedido sempre gera o mesmo hash (D21 garante o mesmo para o valor).
 */
export function computePayloadHash(fields: PayloadHashFields): string {
  // Campos copiados um a um: um objeto maior passado aqui (ex.: o input com
  // a idempotencyKey) não pode vazar campos extras para o hash.
  const withNulls: Record<string, string | null> = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    walletId: fields.walletId,
    playerId: fields.playerId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    amount: fields.amount,
    currency: fields.currency,
    referenceExternalTransactionId: fields.referenceExternalTransactionId ?? null,
  };
  const canonical = Object.fromEntries(
    Object.keys(withNulls)
      .sort()
      .map((key) => [key, withNulls[key]]),
  );
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

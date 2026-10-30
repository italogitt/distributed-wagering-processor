import { InvalidInputError } from './errors';
import type { LedgerPosition } from './ports/wallet-read-model';

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

interface CursorPayload {
  /** walletId: um cursor só vale para a wallet que o gerou. */
  w: string;
  t: string;
  i: string;
}

/**
 * Cursor opaco do extrato: base64url de `{ w, t, i }`, a posição do último
 * lançamento da página. Quem chama não deve montar nem interpretar.
 */
export function encodeLedgerCursor(walletId: string, position: LedgerPosition): string {
  const payload: CursorPayload = { w: walletId, t: position.createdAt, i: position.id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/** Cursor adulterado, de outra wallet ou fora do formato → InvalidInputError (400). */
export function decodeLedgerCursor(cursor: string, walletId: string): LedgerPosition {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidInputError('cursor inválido');
  }
  const { w, t, i } = (payload ?? {}) as Partial<CursorPayload>;
  if (
    w !== walletId ||
    typeof t !== 'string' ||
    !TIMESTAMP_FORMAT.test(t) ||
    Number.isNaN(Date.parse(t)) ||
    typeof i !== 'string' ||
    !UUID_FORMAT.test(i)
  ) {
    throw new InvalidInputError('cursor inválido');
  }
  return { createdAt: t, id: i };
}

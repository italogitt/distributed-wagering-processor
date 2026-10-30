import { ConnectionException, DeadlockException, LockWaitTimeoutException } from '@mikro-orm/core';

/** Códigos de erro de rede do Node. */
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENOTFOUND']);

/**
 * SQLSTATE do Postgres que podem passar sozinhos: classe 08 (conexão),
 * 53300 (conexões esgotadas), 57014 (statement timeout), 57P01-57P03
 * (servidor desligando/reiniciando), 40001/40P01 (serialização/deadlock).
 */
const TRANSIENT_SQLSTATES = new Set([
  '08000', '08001', '08003', '08004', '08006',
  '53300', '57014', '57P01', '57P02', '57P03',
  '40001', '40P01',
]);

/** Mensagens do `pg` sem código: conexão caída ou pool sem conexão livre a tempo. */
const TRANSIENT_MESSAGES = [/connection terminated/i, /timeout exceeded when trying to connect/i];

/** Uma falha que pode passar se tentarmos de novo mais tarde. */
export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof ConnectionException || error instanceof DeadlockException || error instanceof LockWaitTimeoutException) {
    return true;
  }
  // Ex.: "localhost" resolve para IPv4 e IPv6, e o Node agrega as duas recusas.
  if (error instanceof AggregateError) {
    return error.errors.some(isTransientDatabaseError);
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && (NETWORK_CODES.has(code) || TRANSIENT_SQLSTATES.has(code))) {
    return true;
  }
  return TRANSIENT_MESSAGES.some((pattern) => pattern.test(error.message));
}

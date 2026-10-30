/**
 * Backoff exponencial com teto: min(2^tentativas, teto) segundos.
 * Mesma regra no consumer SQS, no publisher da outbox e no worker do
 * PENDING_REFERENCE: 1ª falha → 2 s, 2ª → 4 s, ... até o teto.
 */
export function backoffSeconds(attempts: number, maxSeconds: number): number {
  return Math.min(2 ** attempts, maxSeconds);
}

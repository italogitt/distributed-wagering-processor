export type Env = Record<string, string | undefined>;

/** Inteiro >= 0 vindo de env, com default. Valor inválido derruba a app no boot. */
export function integer(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} deve ser um inteiro >= 0, recebido "${raw}"`);
  }
  return value;
}

/** Só a string "true" liga. */
export function flag(env: Env, name: string): boolean {
  return env[name] === 'true';
}

/** Filas do LocalStack do docker-compose (conta 000000000000). */
export const LOCALSTACK_QUEUE_BASE = 'http://localhost:4566/000000000000';

/**
 * Importado ANTES de qualquer módulo que leia a config do MikroORM: o
 * `mikro-orm.config.ts` lê DATABASE_URL quando é avaliado.
 *
 * Cada execução do `test:integration` usa um banco só dela
 * (`<banco de TEST_DATABASE_URL>_<aleatório>`), criado e apagado pelo
 * `setup.ts` (preload). Assim duas execuções ao mesmo tempo não derrubam o
 * schema uma da outra, e o banco de dev nunca é tocado.
 *
 * O nome fica em process.env para ser o mesmo em todos os arquivos de teste
 * (e nos processos filhos, que herdam o env).
 */
const BASE_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://wallet:wallet@localhost:5432/wallet_test';

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const baseName = new URL(BASE_DATABASE_URL).pathname.slice(1);
process.env.TEST_RUN_DATABASE_NAME ??= `${baseName}_${crypto.randomUUID().replaceAll('-', '')}`;

export const TEST_DATABASE_NAME = process.env.TEST_RUN_DATABASE_NAME;
export const TEST_DATABASE_URL = withDatabase(BASE_DATABASE_URL, TEST_DATABASE_NAME);
/** Banco de manutenção, de onde se cria e apaga o banco da execução. */
export const ADMIN_DATABASE_URL = withDatabase(BASE_DATABASE_URL, 'postgres');

process.env.DATABASE_URL = TEST_DATABASE_URL;

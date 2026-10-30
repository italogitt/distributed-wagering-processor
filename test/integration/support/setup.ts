import { ADMIN_DATABASE_URL, TEST_DATABASE_NAME } from './env';
import { afterAll } from 'bun:test';

/**
 * Preload do `test:integration` (ver package.json): cria o banco desta
 * execução antes do primeiro arquivo e o apaga depois do último. Um afterAll
 * no preload vale para a execução inteira e roda mesmo com teste falhando.
 * `WITH (FORCE)` derruba conexões que tenham sobrado (ex.: processo filho).
 */
const quoted = `"${TEST_DATABASE_NAME.replaceAll('"', '""')}"`;

async function admin(statement: string): Promise<void> {
  const sql = new Bun.SQL(ADMIN_DATABASE_URL);
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.close();
  }
}

const dropDatabase = () => admin(`drop database if exists ${quoted} with (force)`);

await admin(`create database ${quoted}`);
process.env.TEST_RUN_DATABASE_READY = 'true';

afterAll(dropDatabase);

// Ctrl+C / kill no meio da suíte: o afterAll não roda, então apaga aqui.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    dropDatabase().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
}

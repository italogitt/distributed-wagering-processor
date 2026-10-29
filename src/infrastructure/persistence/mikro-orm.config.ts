import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { LedgerEntryRecord } from './entities/ledger-entry.record';
import { TransactionRecord } from './entities/transaction.record';
import { WalletRecord } from './entities/wallet.record';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? 'postgresql://wallet:wallet@localhost:5432/wallet',
  // Lista explícita: sem glob/discovery mágico, e cada entidade nova entra aqui.
  entities: [WalletRecord, TransactionRecord, LedgerEntryRecord],
  extensions: [Migrator],
  migrations: {
    path: './src/infrastructure/persistence/migrations',
    pathTs: './src/infrastructure/persistence/migrations',
    tableName: 'mikro_orm_migrations',
    transactional: true,
    allOrNothing: true,
    snapshot: true,
  },
  debug: process.env.MIKRO_ORM_DEBUG === 'true',
});

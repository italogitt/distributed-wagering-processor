import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletRecord } from './entities/wallet.record';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? 'postgresql://wallet:wallet@localhost:5432/wallet',
  // Lista explícita: sem glob/discovery mágico, e cada entidade nova entra aqui.
  entities: [WalletRecord],
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

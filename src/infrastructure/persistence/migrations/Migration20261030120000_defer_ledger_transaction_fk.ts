import { Migration } from '@mikro-orm/migrations';

/**
 * O caso de uso grava o lançamento (passo 7) antes da linha da transação
 * (passo 9), na mesma transação SQL. Com a FK DEFERRABLE INITIALLY DEFERRED,
 * o Postgres só confere a FK no COMMIT, quando as duas linhas já existem.
 * A garantia continua: um lançamento sem transação não chega a ser commitado.
 */
export class Migration20261030120000_defer_ledger_transaction_fk extends Migration {

  override name = 'Migration20261030120000_defer_ledger_transaction_fk';

  override up(): void | Promise<void> {
    this.addSql(`alter table "ledger_entries" drop constraint "ledger_entries_transaction_id_foreign";`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_transaction_id_foreign" foreign key ("transaction_id") references "transactions" ("id") on update restrict on delete restrict deferrable initially deferred;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "ledger_entries" drop constraint "ledger_entries_transaction_id_foreign";`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_transaction_id_foreign" foreign key ("transaction_id") references "transactions" ("id") on update restrict on delete restrict;`);
  }

}

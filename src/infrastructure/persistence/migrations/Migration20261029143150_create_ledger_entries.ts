import { Migration } from '@mikro-orm/migrations';

export class Migration20261029143150_create_ledger_entries extends Migration {

  override name = 'Migration20261029143150_create_ledger_entries';

  override up(): void | Promise<void> {
    this.addSql(`create table "ledger_entries" ("id" uuid not null default gen_random_uuid(), "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" text not null, "amount" numeric(20,2) not null, "currency" text not null, "balance_before" numeric(20,2) not null, "balance_after" numeric(20,2) not null, "created_at" timestamptz not null default now(), primary key ("id"));`);
    this.addSql(`create index "ledger_entries_transaction_id_idx" on "ledger_entries" ("transaction_id");`);
    this.addSql(`create index "ledger_entries_wallet_cursor_idx" on "ledger_entries" ("wallet_id", "created_at", "id");`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_wallet_transaction_uq" unique ("wallet_id", "transaction_id");`);

    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on update restrict on delete restrict;`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_transaction_id_foreign" foreign key ("transaction_id") references "transactions" ("id") on update restrict on delete restrict;`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_balanced_chk" check ((direction = 'CREDIT' and balance_after = balance_before + amount) or (direction = 'DEBIT' and balance_after = balance_before - amount));`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_balance_after_non_negative_chk" check (balance_after >= 0);`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_balance_before_non_negative_chk" check (balance_before >= 0);`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_currency_iso4217_chk" check (currency ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_amount_positive_chk" check (amount > 0);`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_direction_chk" check (direction in ('DEBIT', 'CREDIT'));`);
    this.addSql(`create or replace function "ledger_entries_no_update_delete_trg_fn"() returns trigger as \$\$ begin raise exception 'ledger_entries is append-only: % is not allowed', TG_OP; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "no_update_delete_trg" BEFORE UPDATE OR DELETE on "ledger_entries" for each ROW execute function "ledger_entries_no_update_delete_trg_fn"();`);

    // Escrito à mão: o MikroORM não enxerga triggers de TRUNCATE (ver LedgerEntryRecord).
    this.addSql(`create or replace function "ledger_entries_no_truncate_trg_fn"() returns trigger as \$\$ begin raise exception 'ledger_entries is append-only: % is not allowed', TG_OP; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "no_truncate_trg" BEFORE TRUNCATE on "ledger_entries" for each STATEMENT execute function "ledger_entries_no_truncate_trg_fn"();`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop trigger if exists "no_truncate_trg" on "ledger_entries";`);
    this.addSql(`drop function if exists "ledger_entries_no_truncate_trg_fn"();`);
    this.addSql(`drop trigger if exists "no_update_delete_trg" on "ledger_entries";`);
    this.addSql(`drop function if exists "ledger_entries_no_update_delete_trg_fn"();`);
    this.addSql(`drop table "ledger_entries";`);
  }

}

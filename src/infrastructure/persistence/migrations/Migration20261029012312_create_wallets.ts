import { Migration } from '@mikro-orm/migrations';

export class Migration20261029012312_create_wallets extends Migration {

  override name = 'Migration20261029012312_create_wallets';

  override up(): void | Promise<void> {
    this.addSql(`create table "wallets" ("id" uuid not null default gen_random_uuid(), "player_id" text not null, "currency" text not null, "balance" numeric(20,2) not null, "version" int not null default 1, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_id_currency_uq" unique ("player_id", "currency");`);

    this.addSql(`alter table "wallets" add constraint "wallets_version_positive_chk" check (version >= 1);`);
    this.addSql(`alter table "wallets" add constraint "wallets_balance_non_negative_chk" check (balance >= 0);`);
    this.addSql(`alter table "wallets" add constraint "wallets_currency_iso4217_chk" check (currency ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_id_not_blank_chk" check (length(btrim(player_id)) > 0);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table "wallets";`);
  }

}

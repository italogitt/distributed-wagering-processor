import { Migration } from '@mikro-orm/migrations';

export class Migration20261029141447_create_transactions extends Migration {

  override name = 'Migration20261029141447_create_transactions';

  override up(): void | Promise<void> {
    this.addSql(`create table "transactions" ("id" uuid not null default gen_random_uuid(), "wallet_id" uuid not null, "player_id" text not null, "kind" text not null, "status" text not null, "amount" numeric(20,2) not null, "currency" text not null, "provider_id" text null, "external_transaction_id" text null, "idempotency_key" text null, "payload_hash" text null, "round_id" text null, "game_id" text null, "reference_external_transaction_id" text null, "reference_transaction_id" uuid null, "failure_code" text null, "balance_after" numeric(20,2) null, "attempts" int not null default 0, "next_attempt_at" timestamptz null, "processed_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), primary key ("id"));`);
    this.addSql(`create index "transactions_wallet_id_idx" on "transactions" ("wallet_id");`);
    this.addSql(`create index "transactions_pending_reference_next_attempt_idx" on "transactions" ("next_attempt_at") where status = 'PENDING_REFERENCE';`);
    this.addSql(`create unique index "transactions_single_reversal_uq" on "transactions" ("provider_id", "reference_external_transaction_id") where kind in ('REFUND', 'ROLLBACK') and status not in ('REJECTED', 'FAILED');`);
    this.addSql(`alter table "transactions" add constraint "transactions_provider_idempotency_key_uq" unique ("provider_id", "idempotency_key");`);
    this.addSql(`alter table "transactions" add constraint "transactions_provider_external_id_uq" unique ("provider_id", "external_transaction_id");`);

    this.addSql(`alter table "transactions" add constraint "transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on update restrict on delete restrict;`);
    this.addSql(`alter table "transactions" add constraint "transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "transactions" ("id") on update restrict on delete restrict;`);
    this.addSql(`alter table "transactions" add constraint "transactions_attempts_non_negative_chk" check (attempts >= 0);`);
    this.addSql(`alter table "transactions" add constraint "transactions_next_attempt_at_chk" check ((status = 'PENDING_REFERENCE') = (next_attempt_at is not null));`);
    this.addSql(`alter table "transactions" add constraint "transactions_balance_after_non_negative_chk" check (balance_after >= 0);`);
    this.addSql(`alter table "transactions" add constraint "transactions_balance_after_chk" check ((status in ('PROCESSED', 'REJECTED')) = (balance_after is not null));`);
    this.addSql(`alter table "transactions" add constraint "transactions_processed_at_chk" check ((status = 'PROCESSED') = (processed_at is not null));`);
    this.addSql(`alter table "transactions" add constraint "transactions_failure_code_chk" check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null));`);
    this.addSql(`alter table "transactions" add constraint "transactions_reference_resolved_chk" check ((status = 'PROCESSED' and reference_external_transaction_id is not null) = (reference_transaction_id is not null));`);
    this.addSql(`alter table "transactions" add constraint "transactions_reference_forbidden_chk" check (kind not in ('OPENING', 'BET', 'LOSS') or reference_external_transaction_id is null);`);
    this.addSql(`alter table "transactions" add constraint "transactions_reference_required_chk" check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null);`);
    this.addSql(`alter table "transactions" add constraint "transactions_opening_processed_chk" check (kind <> 'OPENING' or status = 'PROCESSED');`);
    this.addSql(`alter table "transactions" add constraint "transactions_provider_fields_chk" check (kind = 'OPENING' or (provider_id is not null and external_transaction_id is not null and idempotency_key is not null and payload_hash is not null and round_id is not null and game_id is not null));`);
    this.addSql(`alter table "transactions" add constraint "transactions_amount_by_kind_chk" check ((kind = 'LOSS' and amount = 0) or (kind <> 'LOSS' and amount > 0));`);
    this.addSql(`alter table "transactions" add constraint "transactions_currency_iso4217_chk" check (currency ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "transactions" add constraint "transactions_player_id_not_blank_chk" check (length(btrim(player_id)) > 0);`);
    this.addSql(`alter table "transactions" add constraint "transactions_status_chk" check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);
    this.addSql(`alter table "transactions" add constraint "transactions_kind_chk" check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table "transactions";`);
  }

}

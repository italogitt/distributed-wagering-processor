import { Migration } from '@mikro-orm/migrations';

export class Migration20261029172246_create_outbox_events extends Migration {

  override name = 'Migration20261029172246_create_outbox_events';

  override up(): void | Promise<void> {
    this.addSql(`create table "outbox_events" ("id" uuid not null default gen_random_uuid(), "sequence" bigserial, "aggregate_type" text not null, "aggregate_id" uuid not null, "event_type" text not null, "payload" jsonb not null, "created_at" timestamptz not null default now(), "published_at" timestamptz null, "attempts" int not null default 0, "next_attempt_at" timestamptz not null default now(), "last_error" text null, primary key ("id"));`);
    this.addSql(`alter table "outbox_events" add constraint "outbox_events_sequence_uq" unique ("sequence");`);
    this.addSql(`create index "outbox_events_pending_aggregate_sequence_idx" on "outbox_events" ("aggregate_id", "sequence") where published_at is null;`);
    this.addSql(`create index "outbox_events_pending_next_attempt_idx" on "outbox_events" ("next_attempt_at", "sequence") where published_at is null;`);

    this.addSql(`alter table "outbox_events" add constraint "outbox_events_attempts_non_negative_chk" check (attempts >= 0);`);
    this.addSql(`alter table "outbox_events" add constraint "outbox_events_payload_object_chk" check (jsonb_typeof(payload) = 'object');`);
    this.addSql(`alter table "outbox_events" add constraint "outbox_events_event_type_chk" check (event_type in ('WagerTransactionProcessed', 'WagerTransactionRejected', 'WalletBalanceChanged', 'WagerTransactionPendingReference'));`);
    this.addSql(`alter table "outbox_events" add constraint "outbox_events_aggregate_type_chk" check (aggregate_type in ('wallet', 'transaction'));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table "outbox_events";`);
  }

}

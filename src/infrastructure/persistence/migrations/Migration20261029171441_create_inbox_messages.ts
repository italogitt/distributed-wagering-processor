import { Migration } from '@mikro-orm/migrations';

export class Migration20261029171441_create_inbox_messages extends Migration {

  override name = 'Migration20261029171441_create_inbox_messages';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_messages" ("id" uuid not null default gen_random_uuid(), "consumer" text not null, "message_id" text not null, "received_at" timestamptz not null default now(), primary key ("id"));`);
    this.addSql(`alter table "inbox_messages" add constraint "inbox_messages_consumer_message_id_uq" unique ("consumer", "message_id");`);

    this.addSql(`alter table "inbox_messages" add constraint "inbox_messages_message_id_not_blank_chk" check (length(btrim(message_id)) > 0);`);
    this.addSql(`alter table "inbox_messages" add constraint "inbox_messages_consumer_not_blank_chk" check (length(btrim(consumer)) > 0);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table "inbox_messages";`);
  }

}

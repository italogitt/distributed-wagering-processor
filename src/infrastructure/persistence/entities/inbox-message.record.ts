import { Check, Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

/**
 * Modelo de persistência da tabela `inbox_messages`: deduplicação das mensagens
 * recebidas pela fila SQS.
 *
 * A linha é gravada na mesma transação SQL que processa a mensagem. Se ela
 * existe, a mensagem já foi processada, então não há `processed_at`. Também não
 * há `payload_hash`: a comparação de payload é feita pela idempotência da
 * `transactions`, que é a mesma para HTTP e SQS.
 */
@Entity({ tableName: 'inbox_messages' })
// Uma mensagem só é processada uma vez por consumer, mesmo com redelivery do SQS.
@Unique({ name: 'inbox_messages_consumer_message_id_uq', properties: ['consumer', 'messageId'] })
@Check({ name: 'inbox_messages_consumer_not_blank_chk', expression: 'length(btrim(consumer)) > 0' })
@Check({ name: 'inbox_messages_message_id_not_blank_chk', expression: 'length(btrim(message_id)) > 0' })
export class InboxMessageRecord {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property({ type: 'text' })
  consumer!: string;

  // `messageId` do corpo da mensagem (id de negócio), não o MessageId que o SQS gera.
  @Property({ type: 'text' })
  messageId!: string;

  @Property({ type: 'datetime', columnType: 'timestamptz', defaultRaw: 'now()' })
  receivedAt!: Date;
}

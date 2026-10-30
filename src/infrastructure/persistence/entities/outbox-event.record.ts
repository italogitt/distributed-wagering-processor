import type { Opt } from '@mikro-orm/core';
import { Check, Entity, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * Modelo de persistência da tabela `outbox_events`: eventos de integração
 * gravados na mesma transação SQL da operação financeira e publicados no SQS
 * depois do commit por um worker.
 *
 * Ordem: eventos do mesmo `aggregate_id` saem na ordem de `sequence`. Um evento
 * só é publicado quando não há outro mais antigo do mesmo aggregate pendente,
 * então uma falha em backoff segura os eventos seguintes daquele aggregate.
 */
@Entity({ tableName: 'outbox_events' })
// Fila do publisher: pendentes cuja próxima tentativa já venceu.
@Index({
  name: 'outbox_events_pending_next_attempt_idx',
  properties: ['nextAttemptAt', 'sequence'],
  where: 'published_at is null',
})
// "Existe evento mais antigo pendente deste aggregate?" (garante a ordem FIFO).
@Index({
  name: 'outbox_events_pending_aggregate_sequence_idx',
  properties: ['aggregateId', 'sequence'],
  where: 'published_at is null',
})
@Check({ name: 'outbox_events_aggregate_type_chk', expression: "aggregate_type in ('wallet', 'transaction')" })
@Check({
  name: 'outbox_events_event_type_chk',
  expression:
    "event_type in ('WagerTransactionProcessed', 'WagerTransactionRejected'," +
    " 'WalletBalanceChanged', 'WagerTransactionPendingReference')",
})
@Check({ name: 'outbox_events_payload_object_chk', expression: "jsonb_typeof(payload) = 'object'" })
@Check({ name: 'outbox_events_attempts_non_negative_chk', expression: 'attempts >= 0' })
export class OutboxEventRecord {
  // É o `eventId` do envelope e o MessageDeduplicationId no SQS.
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  // Gerado pelo banco na ordem de inserção. Define a ordem FIFO dentro do aggregate.
  // O MikroORM hidrata `bigint` como `bigint` do JS (não é dinheiro, então tudo bem).
  // `Opt`: o INSERT não informa o valor, quem gera é o bigserial.
  @Property({ type: 'bigint', autoincrement: true, unique: 'outbox_events_sequence_uq' })
  sequence!: Opt<bigint>;

  @Property({ type: 'text' })
  aggregateType!: string;

  // MessageGroupId no SQS: a fila FIFO mantém a ordem por grupo.
  @Property({ type: 'uuid' })
  aggregateId!: string;

  @Property({ type: 'text' })
  eventType!: string;

  // Envelope serializado (IntegrationEvent.toJSON()).
  @Property({ type: 'json', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ type: 'datetime', columnType: 'timestamptz', defaultRaw: 'now()' })
  createdAt!: Date;

  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Property({ type: 'integer', default: 0 })
  attempts!: number;

  // Backoff: depois de uma falha, o publisher só tenta de novo a partir daqui.
  @Property({ type: 'datetime', columnType: 'timestamptz', defaultRaw: 'now()' })
  nextAttemptAt!: Date;

  @Property({ type: 'text', nullable: true })
  lastError!: string | null;
}

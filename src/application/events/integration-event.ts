/** Dados comuns a todo evento, montados pelo caso de uso. */
export interface EventContext {
  eventId: string;
  /** Id da requisição (header x-request-id ou gerado). */
  correlationId: string;
  /** O que causou o evento: o id da transação. */
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  aggregateId: string;
  data: T;
}

/** Tipos de aggregate aceitos pela outbox (CHECK `outbox_events_aggregate_type_chk`). */
export type AggregateType = 'wallet' | 'transaction';

export interface IntegrationEventJSON<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  /** ISO-8601. */
  occurredAt: string;
  version: number;
  data: T;
}

/**
 * Envelope dos eventos publicados (seção 11). `eventType`, `version` e
 * `aggregateType` ficam na subclasse, não numa string solta no call site.
 * `data` só carrega JSON estável (MoneyProps, nunca Money).
 *
 * `aggregateType` não vai no envelope: é só para a coluna da outbox.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  abstract readonly aggregateType: AggregateType;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON(): IntegrationEventJSON<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}

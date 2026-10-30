import type { PendingOutboxEvent } from './outbox.repository';

/**
 * Publica um evento da outbox no broker. Precisa ser seguro repetir: o mesmo
 * `eventId` pode ser publicado de novo se o processo cair entre o envio e a
 * marcação de `published_at` (D19).
 */
export interface EventPublisher {
  publish(event: PendingOutboxEvent): Promise<void>;
}

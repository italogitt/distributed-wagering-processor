import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports/event-publisher';
import type { PendingOutboxEvent } from '../../application/ports/outbox.repository';

/**
 * Publica na `wallet-events.fifo`:
 * - MessageGroupId = aggregateId: a fila FIFO entrega em ordem dentro do aggregate;
 * - MessageDeduplicationId = eventId: uma republicação dentro de 5 minutos é
 *   descartada pelo próprio SQS. Depois disso, quem consome deduplica pelo eventId.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(event: PendingOutboxEvent): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(event.payload),
        MessageGroupId: event.aggregateId,
        MessageDeduplicationId: event.eventId,
      }),
    );
  }
}

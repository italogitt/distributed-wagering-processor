import './env';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { createSqsClient, loadSqsConfig } from '../../../src/infrastructure/sqs/sqs.config';
import type { SeededWallet } from './database';

export const sqs: SQSClient = createSqsClient(loadSqsConfig());

export interface TestQueues {
  queueUrl: string;
  dlqUrl: string;
}

/**
 * Filas próprias de cada teste (mesma configuração do init script:
 * FIFO + redrive com maxReceiveCount = 5). Assim um teste não vê mensagens
 * de outro e não precisa de PurgeQueue.
 */
export async function createTestQueues(): Promise<TestQueues> {
  const name = `t-${Bun.randomUUIDv7()}`;
  const { QueueUrl: dlqUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: `${name}-dlq.fifo`, Attributes: { FifoQueue: 'true' } }),
  );
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
  const { QueueUrl: queueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: `${name}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes!.QueueArn, maxReceiveCount: '5' }),
      },
    }),
  );
  return { queueUrl: queueUrl!, dlqUrl: dlqUrl! };
}

export async function deleteTestQueues(queues: TestQueues): Promise<void> {
  await Promise.all([queues.queueUrl, queues.dlqUrl].map((url) => sqs.send(new DeleteQueueCommand({ QueueUrl: url }))));
}

/** Fila de eventos própria do teste (como a wallet-events.fifo: FIFO, dedup pelo id que o publisher manda). */
export async function createEventsQueue(): Promise<string> {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: `t-${Bun.randomUUIDv7()}-events.fifo`, Attributes: { FifoQueue: 'true' } }),
  );
  return QueueUrl!;
}

export async function deleteQueue(queueUrl: string): Promise<void> {
  await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
}

export interface ReceivedEvent {
  body: Record<string, unknown>;
  groupId: string | undefined;
  deduplicationId: string | undefined;
}

/**
 * Lê e apaga mensagens até juntar `expected` (na ordem de entrega) e depois
 * confere, com um receive extra, que não sobrou nada. Precisa apagar: numa
 * fila FIFO, o grupo fica bloqueado enquanto houver mensagem dele em andamento.
 */
export async function drainQueue(queueUrl: string, expected: number, { timeoutMs = 15_000 } = {}): Promise<ReceivedEvent[]> {
  const received: ReceivedEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  const receive = async (waitTimeSeconds: number) => {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitTimeSeconds,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
      }),
    );
    for (const message of Messages) {
      received.push({
        body: JSON.parse(message.Body!),
        groupId: message.Attributes?.MessageGroupId,
        deduplicationId: message.Attributes?.MessageDeduplicationId,
      });
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
    return Messages.length;
  };
  while (received.length < expected) {
    if (Date.now() > deadline) throw new Error(`drainQueue: ${received.length}/${expected} mensagens`);
    await receive(1);
  }
  await receive(1); // nada além do esperado
  return received;
}

/** Envolve o client real e registra o MessageDeduplicationId de cada SendMessage que deu certo. */
export function countingSqs(inner: SQSClient = sqs): { client: SQSClient; sent: string[] } {
  const sent: string[] = [];
  const client = {
    send: async (command: Parameters<SQSClient['send']>[0], options?: unknown) => {
      const output = await inner.send(command as never, options as never);
      if (command instanceof SendMessageCommand) sent.push(command.input.MessageDeduplicationId!);
      return output;
    },
  } as unknown as SQSClient;
  return { client, sent };
}

export interface WagerMessageBody {
  messageId: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

/** Mensagem da seção 10. Sem `externalTransactionId`, gera um novo. */
export function wagerMessage(
  wallet: SeededWallet,
  overrides: {
    messageId?: string;
    externalTransactionId?: string;
    kind?: string;
    amount?: string;
    referenceExternalTransactionId?: string;
  } = {},
): WagerMessageBody {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${Bun.randomUUIDv7()}`;
  return {
    messageId: overrides.messageId ?? `msg-${Bun.randomUUIDv7()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: overrides.kind ?? 'BET',
      money: { amount: overrides.amount ?? '10.00', currency: wallet.currency },
      ...(overrides.referenceExternalTransactionId
        ? { referenceExternalTransactionId: overrides.referenceExternalTransactionId }
        : {}),
    },
  };
}

/**
 * Envia para a fila FIFO. O MessageDeduplicationId é sempre novo, para o
 * dedup de 5 minutos do SQS não esconder reenvios: quem deduplica é a inbox.
 */
export async function send(queueUrl: string, body: WagerMessageBody | string, groupId = 'wallet'): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
}

/** Mensagens na fila: visíveis + em andamento (invisíveis). */
export async function queueDepth(queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    visible: Number(Attributes.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

/** Lê (sem apagar) as mensagens da DLQ. */
export async function peekDlq(dlqUrl: string): Promise<Message[]> {
  const { Messages = [] } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: dlqUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 0,
      MessageAttributeNames: ['All'],
    }),
  );
  return Messages;
}

/** Espera uma condição com polling curto; falha com a última leitura se estourar o prazo. */
export async function waitUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  { timeoutMs = 15_000, intervalMs = 200 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > deadline) {
      throw new Error(`waitUntil estourou ${timeoutMs}ms; último valor: ${JSON.stringify(value)}`);
    }
    await Bun.sleep(intervalMs);
    value = await read();
  }
  return value;
}

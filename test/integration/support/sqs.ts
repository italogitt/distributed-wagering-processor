import './env';
import {
  CreateQueueCommand,
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

export interface WagerMessageBody {
  messageId: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

/** Mensagem da seção 10. Sem `externalTransactionId`, gera um novo. */
export function wagerMessage(
  wallet: SeededWallet,
  overrides: { messageId?: string; externalTransactionId?: string; kind?: string; amount?: string } = {},
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

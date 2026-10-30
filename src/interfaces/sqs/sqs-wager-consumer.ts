import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { backoffSeconds } from '../../application/backoff';
import { ApplicationError, DuplicateMessageError, InvalidInputError } from '../../application/errors';
import type { SubmitTransactionUseCase } from '../../application/use-cases/submit-transaction.use-case';
import { errorFields, type LogFields, type Logger } from '../../infrastructure/logging/logger';
import { settlesWithin, sleep } from '../workers/timing';
import { parseWagerMessage, type WagerMessage } from './wager-message';

export interface SqsConsumerOptions {
  enabled: boolean;
  /** Nome do consumer na inbox: (consumer, messageId) é a chave de deduplicação. */
  consumerName: string;
  queueUrl: string;
  dlqUrl: string;
  /** Long polling: quanto o ReceiveMessage espera por mensagens. */
  waitTimeSeconds: number;
  /** Quanto tempo a mensagem fica invisível para os outros enquanto processamos. */
  visibilityTimeoutSeconds: number;
  maxMessages: number;
  /** Teto do backoff de erro transitório: min(2^ApproximateReceiveCount, teto). */
  backoffMaxSeconds: number;
  /** No SIGTERM, quanto esperar pelas mensagens em andamento antes de devolvê-las. */
  shutdownTimeoutMs: number;
}

/**
 * processed: decisão de negócio tomada (PROCESSED, REJECTED, PENDING_REFERENCE, 404, 409, 422) → ack.
 * duplicate: já estava na inbox → ack sem efeito.
 * retry: erro transitório → sem ack, volta depois do backoff.
 * dlq: mensagem permanente (malformada, type desconhecido, payload inválido) → DLQ + ack.
 * released: não processada (SIGTERM, ou mensagem seguinte do mesmo grupo de uma que falhou) → visibilidade 0.
 */
export type MessageOutcome = 'processed' | 'duplicate' | 'retry' | 'dlq' | 'released';

export interface MessageResult {
  sqsMessageId: string;
  messageId?: string;
  outcome: MessageOutcome;
  /** Status da transação, nome do erro de negócio ou motivo. */
  detail: string;
}

/**
 * Consumer da `wager-transactions.fifo` (seção 10). Chama o MESMO caso de uso
 * da API HTTP, com a inbox na mesma transação SQL; o ack (DeleteMessage) só
 * acontece depois do commit.
 *
 * Mensagens do mesmo MessageGroupId são processadas em ordem, uma de cada vez;
 * grupos diferentes, em paralelo.
 */
export class SqsWagerConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private loop?: Promise<void>;
  private abort = new AbortController();
  /** Recebidas e ainda não resolvidas, pelo ReceiptHandle. */
  private readonly inFlight = new Map<string, Message>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly submitTransaction: SubmitTransactionUseCase,
    private readonly options: SqsConsumerOptions,
    private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.enabled) {
      this.start();
    }
  }

  /** Roda antes do MikroORM fechar (onApplicationShutdown): o banco ainda está aberto no drain. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.run();
    this.logger.info('sqs consumer started', { queueUrl: this.options.queueUrl });
  }

  /**
   * Para de receber, espera as mensagens em andamento até `shutdownTimeoutMs`
   * e devolve (visibilidade 0) as que não terminaram. Uma que termine depois
   * disso e chegue a commitar é barrada pela inbox na redelivery.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    const drained = await settlesWithin(this.loop, this.options.shutdownTimeoutMs);
    const pending = [...this.inFlight.values()];
    await Promise.all(pending.map((message) => this.release(message, 'shutdown')));
    this.logger.info('sqs consumer stopped', { drained, released: pending.length });
  }

  /** Um ciclo de receive + processamento. Usado pelo loop e pelos testes. */
  async pollOnce(signal?: AbortSignal): Promise<MessageResult[]> {
    const messages = await this.receive(signal);
    return this.processBatch(messages);
  }

  private async run(): Promise<void> {
    while (this.running) {
      let messages: Message[];
      try {
        messages = await this.receive(this.abort.signal);
      } catch (error) {
        if (!this.running) break; // receive abortado pelo stop()
        this.logger.error('sqs receive failed', errorFields(error));
        await sleep(1_000, this.abort.signal);
        continue;
      }
      await this.processBatch(messages);
    }
  }

  private async receive(signal?: AbortSignal): Promise<Message[]> {
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: this.options.maxMessages,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        VisibilityTimeout: this.options.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: signal },
    );
    for (const message of Messages) {
      this.inFlight.set(message.ReceiptHandle!, message);
    }
    return Messages;
  }

  private async processBatch(messages: Message[]): Promise<MessageResult[]> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId!;
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    const results = await Promise.all(
      [...groups.values()].map(async (group) => {
        const groupResults: MessageResult[] = [];
        for (const [index, message] of group.entries()) {
          const result = await this.handle(message);
          groupResults.push(result);
          if (result.outcome === 'retry') {
            // Mantém a ordem do grupo: as seguintes voltam para a fila sem
            // processar. O FIFO só as entrega depois que esta for resolvida.
            for (const next of group.slice(index + 1)) {
              groupResults.push(await this.release(next, 'previous message in group will be retried'));
            }
            break;
          }
        }
        return groupResults;
      }),
    );
    return results.flat();
  }

  private async handle(message: Message): Promise<MessageResult> {
    const startedAt = performance.now();
    const base: LogFields = {
      sqsMessageId: message.MessageId,
      receiveCount: receiveCountOf(message),
    };

    let wager: WagerMessage;
    try {
      wager = parseWagerMessage(message.Body);
    } catch (error) {
      return this.sendToDlq(message, error, base, startedAt);
    }

    const fields: LogFields = {
      ...base,
      messageId: wager.messageId,
      correlationId: wager.messageId,
      providerId: wager.input.providerId,
      walletId: wager.input.walletId,
    };
    try {
      const output = await this.submitTransaction.execute(wager.input, {
        inbox: { consumer: this.options.consumerName, messageId: wager.messageId },
      });
      const result = { ...fields, transactionId: output.transactionId, idempotentReplay: output.idempotentReplay };
      return this.ack(message, 'processed', output.status, result, startedAt);
    } catch (error) {
      if (error instanceof DuplicateMessageError) {
        return this.ack(message, 'duplicate', 'ALREADY_IN_INBOX', fields, startedAt);
      }
      if (error instanceof InvalidInputError) {
        return this.sendToDlq(message, error, fields, startedAt);
      }
      if (error instanceof ApplicationError) {
        // 404, 409, 422: decisão de negócio, reenviar não muda nada.
        return this.ack(message, 'processed', error.name, fields, startedAt);
      }
      // Transitório (TransientInfrastructureError) ou desconhecido: tenta de
      // novo; depois de maxReceiveCount recebimentos, o redrive manda para a DLQ.
      return this.retry(message, error, fields, startedAt);
    }
  }

  private async ack(
    message: Message,
    outcome: MessageOutcome,
    detail: string,
    fields: LogFields,
    startedAt: number,
  ): Promise<MessageResult> {
    if (this.settle(message)) {
      try {
        await this.sqs.send(
          new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
      } catch (error) {
        // Já commitado: a redelivery será barrada pela inbox.
        this.logger.warn('sqs ack failed', { ...fields, ...errorFields(error) });
      }
    }
    this.log('info', outcome, detail, fields, startedAt);
    return this.result(message, outcome, detail, fields);
  }

  private async retry(message: Message, error: unknown, fields: LogFields, startedAt: number): Promise<MessageResult> {
    const delaySeconds = backoffSeconds(receiveCountOf(message), this.options.backoffMaxSeconds);
    if (this.settle(message)) {
      try {
        await this.sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.options.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: delaySeconds,
          }),
        );
      } catch (changeError) {
        // Sem o backoff, a mensagem volta quando o visibility timeout vencer.
        this.logger.warn('sqs change visibility failed', { ...fields, ...errorFields(changeError) });
      }
    }
    const detail = error instanceof Error ? error.name : 'UnknownError';
    this.log('warn', 'retry', detail, { ...fields, ...errorFields(error), backoffSeconds: delaySeconds }, startedAt);
    return this.result(message, 'retry', detail, fields);
  }

  private async sendToDlq(message: Message, error: unknown, fields: LogFields, startedAt: number): Promise<MessageResult> {
    const reason = error instanceof Error ? error.message : String(error);
    if (this.inFlight.has(message.ReceiptHandle!)) {
      try {
        await this.sqs.send(
          new SendMessageCommand({
            QueueUrl: this.options.dlqUrl,
            MessageBody: message.Body ?? '',
            MessageGroupId: message.Attributes?.MessageGroupId ?? 'invalid',
            // O MessageId do SQS é único por envio: um reenvio para a DLQ (após falha no ack) é deduplicado.
            MessageDeduplicationId: message.MessageId,
            MessageAttributes: { failureReason: { DataType: 'String', StringValue: reason.slice(0, 256) } },
          }),
        );
      } catch (sendError) {
        // Sem a cópia na DLQ, não dá ack: trata como transitório.
        return this.retry(message, sendError, fields, startedAt);
      }
    }
    return this.ack(message, 'dlq', reason, fields, startedAt);
  }

  private async release(message: Message, reason: string): Promise<MessageResult> {
    if (this.settle(message)) {
      try {
        await this.sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.options.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0,
          }),
        );
      } catch (error) {
        this.logger.warn('sqs release failed', { sqsMessageId: message.MessageId, ...errorFields(error) });
      }
    }
    this.logger.info('sqs message released', { sqsMessageId: message.MessageId, outcome: 'released', reason });
    return { sqsMessageId: message.MessageId!, outcome: 'released', detail: reason };
  }

  /**
   * Tira a mensagem da lista em andamento. `false` se ela já foi devolvida
   * (ex.: pelo stop()): aí não mexemos mais nela no SQS.
   */
  private settle(message: Message): boolean {
    return this.inFlight.delete(message.ReceiptHandle!);
  }

  private log(level: 'info' | 'warn', outcome: MessageOutcome, detail: string, fields: LogFields, startedAt: number) {
    this.logger[level]('sqs message handled', {
      ...fields,
      outcome,
      detail,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }

  private result(message: Message, outcome: MessageOutcome, detail: string, fields: LogFields): MessageResult {
    const messageId = typeof fields.messageId === 'string' ? fields.messageId : undefined;
    return { sqsMessageId: message.MessageId!, messageId, outcome, detail };
  }
}

function receiveCountOf(message: Message): number {
  return Number(message.Attributes?.ApproximateReceiveCount ?? 1);
}

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DeleteMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { ConnectionException } from '@mikro-orm/core';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work';
import type { MessageResult, SqsWagerConsumer } from '../../src/interfaces/sqs/sqs-wager-consumer';
import { startApp } from './support/app';
import { type ConsumerHarness, createConsumer } from './support/consumer';
import {
  assertLedgerInvariant,
  closeDatabase,
  countInboxMessages,
  countLedgerEntries,
  countOutboxEvents,
  countWalletTransactions,
  lockWallet,
  resetDatabase,
  seedWallet,
  walletState,
} from './support/database';
import { TEST_DATABASE_URL } from './support/env';
import {
  createTestQueues,
  deleteTestQueues,
  peekDlq,
  queueDepth,
  send,
  sqs,
  type TestQueues,
  waitUntil,
  wagerMessage,
} from './support/sqs';

// Cada teste espera ao menos um long poll (1 s) e às vezes backoffs de 1 s:
// o limite padrão do Bun (5 s) é curto para isso, não para esconder lentidão.
const SQS_TEST_TIMEOUT_MS = 20_000;

let queues: TestQueues;
let harnesses: ConsumerHarness[] = [];

beforeAll(resetDatabase);
afterAll(closeDatabase);

beforeEach(async () => {
  queues = await createTestQueues();
});

afterEach(async () => {
  await Promise.all(harnesses.map((h) => h.close()));
  harnesses = [];
  await deleteTestQueues(queues);
  await assertLedgerInvariant();
});

async function consumer(overrides: Parameters<typeof createConsumer>[1] = {}): Promise<ConsumerHarness> {
  const harness = await createConsumer(queues, overrides);
  harnesses.push(harness);
  return harness;
}

/** Chama pollOnce até juntar `count` resultados (ou estourar o prazo). */
async function drain(target: SqsWagerConsumer, count: number, timeoutMs = 15_000): Promise<MessageResult[]> {
  const results: MessageResult[] = [];
  const deadline = Date.now() + timeoutMs;
  while (results.length < count) {
    if (Date.now() > deadline) throw new Error(`drain: ${results.length}/${count} resultados`);
    results.push(...(await target.pollOnce()));
  }
  return results;
}

const queueIsEmpty = () =>
  waitUntil(
    () => queueDepth(queues.queueUrl),
    (d) => d.visible === 0 && d.inFlight === 0,
  );

/** Falha transitória de verdade: lançada DENTRO da transação SQL, traduzida pelo MikroOrmUnitOfWork. */
const failingTransiently = (times: number) => (inner: UnitOfWork): UnitOfWork => {
  let remaining = times;
  return {
    run: (work) =>
      inner.run(async (repos) => {
        if (remaining > 0) {
          remaining -= 1;
          throw new ConnectionException(new Error('conexão simulada caiu'));
        }
        return work(repos);
      }),
  };
};

test(
  '1. mensagem válida → transação gravada, linha na inbox, fila vazia (app Nest com o consumer ligado)',
  async () => {
    const wallet = await seedWallet('100.00');
    const message = wagerMessage(wallet);
    const app = await withEnv(
      {
        SQS_CONSUMER_ENABLED: 'true',
        SQS_WAGER_QUEUE_URL: queues.queueUrl,
        SQS_WAGER_DLQ_URL: queues.dlqUrl,
        SQS_WAIT_TIME_SECONDS: '1',
      },
      startApp,
    );
    try {
      await send(queues.queueUrl, message);
      await waitUntil(() => countInboxMessages(message.messageId), (n) => n === 1);
      await queueIsEmpty();
    } finally {
      await app.close();
    }

    expect(await countWalletTransactions(wallet.id)).toBe(1);
    expect(await walletState(wallet.id)).toEqual({ balance: '90.00', version: 2 });
    expect(await countOutboxEvents(wallet.id)).toBe(2); // Processed + BalanceChanged
    expect(await peekDlq(queues.dlqUrl)).toHaveLength(0);
  },
  SQS_TEST_TIMEOUT_MS,
);

test(
  '2. mesmo messageId entregue 2x (dedup id diferente) → 1 efeito, 2 acks',
  async () => {
    const { consumer: c } = await consumer();
    const wallet = await seedWallet('100.00');
    const message = wagerMessage(wallet);
    await send(queues.queueUrl, message);
    await send(queues.queueUrl, message);

    const results = await drain(c, 2);

    expect(results.map((r) => r.outcome)).toEqual(['processed', 'duplicate']);
    await queueIsEmpty();
    expect(await countWalletTransactions(wallet.id)).toBe(1);
    expect(await countInboxMessages(message.messageId)).toBe(1);
    expect(await walletState(wallet.id)).toEqual({ balance: '90.00', version: 2 });
  },
  SQS_TEST_TIMEOUT_MS,
);

test(
  '3. processo morre depois do commit e antes do ack → redelivery → inbox barra → sem efeito duplicado',
  async () => {
    // Este consumer "morre" antes do ack: o DeleteMessage nunca chega ao SQS.
    const withoutAck = {
      send: (command: unknown, options?: unknown) =>
        command instanceof DeleteMessageCommand
          ? Promise.resolve({})
          : sqs.send(command as never, options as never),
    } as unknown as SQSClient;
    const dying = await consumer({ sqs: withoutAck, options: { visibilityTimeoutSeconds: 2 } });
    const wallet = await seedWallet('100.00');
    const message = wagerMessage(wallet);
    await send(queues.queueUrl, message);

    expect((await drain(dying.consumer, 1))[0]!.outcome).toBe('processed');
    expect(await countWalletTransactions(wallet.id)).toBe(1);
    expect(await queueDepth(queues.queueUrl)).toEqual({ visible: 0, inFlight: 1 }); // sem ack

    // Outra instância recebe a mesma mensagem quando a visibilidade vence.
    const survivor = await consumer();
    expect((await drain(survivor.consumer, 1))[0]!.outcome).toBe('duplicate');

    await queueIsEmpty();
    expect(await countWalletTransactions(wallet.id)).toBe(1);
    expect(await countLedgerEntries(wallet.id)).toBe(2);
    expect(await walletState(wallet.id)).toEqual({ balance: '90.00', version: 2 });
  },
  SQS_TEST_TIMEOUT_MS,
);

describe('4. erro transitório', () => {
  test(
    'falha 2 vezes → retry com backoff e depois sucesso',
    async () => {
      const { consumer: c, logger } = await consumer({ wrapUnitOfWork: failingTransiently(2) });
      const wallet = await seedWallet('100.00');
      await send(queues.queueUrl, wagerMessage(wallet));

      const results = await drain(c, 3);

      expect(results.map((r) => r.outcome)).toEqual(['retry', 'retry', 'processed']);
      const retries = logger.lines.filter((l) => l.outcome === 'retry');
      expect(retries.map((l) => l.errorName)).toEqual(['TransientInfrastructureError', 'TransientInfrastructureError']);
      expect(retries.map((l) => l.receiveCount)).toEqual([1, 2]);
      await queueIsEmpty();
      expect(await countWalletTransactions(wallet.id)).toBe(1);
      expect(await walletState(wallet.id)).toEqual({ balance: '90.00', version: 2 });
    },
    SQS_TEST_TIMEOUT_MS,
  );

  test(
    'falha sempre → 5 recebimentos e o redrive manda para a DLQ',
    async () => {
      const { consumer: c, logger } = await consumer({ wrapUnitOfWork: failingTransiently(Number.POSITIVE_INFINITY) });
      const wallet = await seedWallet('100.00');
      const message = wagerMessage(wallet);
      await send(queues.queueUrl, message);

      c.start();
      const dlq = await waitUntil(() => peekDlq(queues.dlqUrl), (m) => m.length === 1, { timeoutMs: 25_000 });
      await c.stop();

      expect(JSON.parse(dlq[0]!.Body!).messageId).toBe(message.messageId);
      expect(logger.outcomes()).toEqual(['retry', 'retry', 'retry', 'retry', 'retry']);
      await queueIsEmpty();
      expect(await countWalletTransactions(wallet.id)).toBe(0);
      expect(await countInboxMessages(message.messageId)).toBe(0);
    },
    30_000,
  );
});

describe('5. mensagem permanente → DLQ, nada gravado', () => {
  test.each([
    ['JSON inválido', () => '{"messageId": "msg-x", '],
    ['type desconhecido', (body: ReturnType<typeof wagerMessage>) => JSON.stringify({ ...body, type: 'Outro' })],
    [
      'valor inválido (InvalidInputError do caso de uso)',
      (body: ReturnType<typeof wagerMessage>) =>
        JSON.stringify({ ...body, data: { ...body.data, money: { amount: '25', currency: 'BRL' } } }),
    ],
  ])(
    '%s',
    async (_case, makeBody) => {
      const { consumer: c } = await consumer();
      const wallet = await seedWallet('100.00');
      const body = wagerMessage(wallet);
      await send(queues.queueUrl, makeBody(body));

      const [result] = await drain(c, 1);

      expect(result!.outcome).toBe('dlq');
      await queueIsEmpty();
      const dlq = await peekDlq(queues.dlqUrl);
      expect(dlq).toHaveLength(1);
      expect(dlq[0]!.MessageAttributes?.failureReason?.StringValue).toBe(result!.detail);
      expect(await countWalletTransactions(wallet.id)).toBe(0);
      expect(await countInboxMessages(body.messageId)).toBe(0);
      expect(await countOutboxEvents(wallet.id)).toBe(0);
    },
    SQS_TEST_TIMEOUT_MS,
  );
});

test(
  '6. wallet inexistente → ack, nada na DLQ, nada gravado',
  async () => {
    const { consumer: c } = await consumer();
    const ghost = { id: Bun.randomUUIDv7(), playerId: 'player-x', currency: 'BRL' };
    const message = wagerMessage(ghost);
    await send(queues.queueUrl, message);

    const [result] = await drain(c, 1);

    expect(result).toMatchObject({ outcome: 'processed', detail: 'WalletNotFoundError' });
    await queueIsEmpty();
    expect(await peekDlq(queues.dlqUrl)).toHaveLength(0);
    expect(await countInboxMessages(message.messageId)).toBe(0); // o rollback levou a inbox junto (I8)
  },
  SQS_TEST_TIMEOUT_MS,
);

test(
  '7. 3 consumers em paralelo, 50 mensagens com a mesma idempotencyKey (messageIds diferentes) → um único débito',
  async () => {
    // maxMessages baixo espalha as mensagens entre os 3 consumers.
    const consumers = await Promise.all([1, 2, 3].map(() => consumer({ options: { maxMessages: 3 } })));
    const wallet = await seedWallet('100.00');
    const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
    const prefix = `msg-${Bun.randomUUIDv7()}-`;
    // MessageGroupId diferente por mensagem: no FIFO, o mesmo grupo seria
    // entregue uma de cada vez e não haveria disputa nenhuma.
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        send(queues.queueUrl, wagerMessage(wallet, { messageId: `${prefix}${i}`, externalTransactionId }), `g-${i}`),
      ),
    );

    for (const { consumer: c } of consumers) c.start();
    await waitUntil(() => countInboxMessages(prefix), (n) => n === 50, { timeoutMs: 20_000 });
    await queueIsEmpty();

    const handled = consumers.flatMap((h) => h.logger.lines.filter((l) => l.message === 'sqs message handled'));
    expect(handled).toHaveLength(50);
    expect(handled.every((l) => l.outcome === 'processed' && l.detail === 'PROCESSED')).toBe(true);
    expect(handled.filter((l) => l.idempotentReplay === false)).toHaveLength(1);
    // Disputa real: mais de um consumer processou mensagens.
    expect(consumers.filter((h) => h.logger.outcomes().length > 0).length).toBeGreaterThan(1);

    expect(await countWalletTransactions(wallet.id)).toBe(1);
    expect(await countLedgerEntries(wallet.id)).toBe(2);
    expect(await walletState(wallet.id)).toEqual({ balance: '90.00', version: 2 });
  },
  30_000,
);

test(
  '8. atomicidade: falha forçada depois da inbox e da outbox, antes do commit → nada fica gravado',
  async () => {
    const { consumer: c } = await consumer({
      wrapUnitOfWork: (inner) => ({
        run: (work) =>
          inner.run((repos) =>
            work({
              ...repos,
              // Último passo do caso de uso: grava a outbox e só então falha.
              outbox: {
                add: async (events) => {
                  await repos.outbox.add(events);
                  throw new Error('falha forçada antes do commit');
                },
              },
            }),
          ),
      }),
    });
    const wallet = await seedWallet('100.00');
    const message = wagerMessage(wallet);
    await send(queues.queueUrl, message);

    const [result] = await drain(c, 1);

    expect(result!.outcome).toBe('retry');
    expect(await countInboxMessages(message.messageId)).toBe(0);
    expect(await countWalletTransactions(wallet.id)).toBe(0);
    expect(await countLedgerEntries(wallet.id)).toBe(1); // só a abertura
    expect(await countOutboxEvents(wallet.id)).toBe(0);
    expect(await walletState(wallet.id)).toEqual({ balance: '100.00', version: 1 });
  },
  SQS_TEST_TIMEOUT_MS,
);

describe('9. SIGTERM com mensagem em andamento (processo real: bun src/main.ts)', () => {
  test(
    'termina dentro do prazo → commit + ack antes de sair',
    async () => {
      const wallet = await seedWallet('100.00');
      const message = wagerMessage(wallet);
      const app = await spawnApp({ SQS_SHUTDOWN_TIMEOUT_MS: '10000' });
      // Segura o UPDATE da wallet: a mensagem fica "em andamento" de propósito.
      const lock = await lockWallet(wallet.id);
      await send(queues.queueUrl, message);
      await waitUntil(() => queueDepth(queues.queueUrl), (d) => d.inFlight === 1);
      await Bun.sleep(300); // tempo de o consumer chegar ao UPDATE travado

      app.process.kill('SIGTERM');
      await Bun.sleep(500);
      await lock.release(); // a mensagem termina durante o drain
      await waitUntil(async () => app.process.exitCode ?? app.process.signalCode, (code) => code !== null);

      const handled = app.logs().filter((l) => l.message === 'sqs message handled');
      expect(handled.map((l) => l.outcome)).toEqual(['processed']);
      expect(app.logs().find((l) => l.message === 'sqs consumer stopped')).toMatchObject({ drained: true, released: 0 });
      await queueIsEmpty();
      expect(await countWalletTransactions(wallet.id)).toBe(1);
      expect(await countInboxMessages(message.messageId)).toBe(1);
      expect(await walletState(wallet.id)).toEqual({ balance: '90.00', version: 2 });
    },
    SQS_TEST_TIMEOUT_MS,
  );

  test(
    'não termina no prazo → volta para a fila; outra instância processa uma vez só',
    async () => {
      const wallet = await seedWallet('100.00');
      const message = wagerMessage(wallet);
      const app = await spawnApp({ SQS_SHUTDOWN_TIMEOUT_MS: '1000' });
      const lock = await lockWallet(wallet.id);
      await send(queues.queueUrl, message);
      await waitUntil(() => queueDepth(queues.queueUrl), (d) => d.inFlight === 1);
      await Bun.sleep(300);

      app.process.kill('SIGTERM');
      // Depois do prazo de 1 s, a mensagem volta a ficar visível (sem perda).
      await waitUntil(() => queueDepth(queues.queueUrl), (d) => d.visible === 1);
      expect(app.logs().find((l) => l.message === 'sqs consumer stopped')).toMatchObject({ drained: false, released: 1 });

      // A transação do processo antigo ainda está aberta, esperando o lock.
      // Ao soltar, ela pode commitar; a inbox impede o efeito duplicado.
      await lock.release();
      await waitUntil(async () => app.process.exitCode ?? app.process.signalCode, (code) => code !== null);
      const survivor = await consumer();
      const [result] = await drain(survivor.consumer, 1);

      expect(['processed', 'duplicate']).toContain(result!.outcome);
      await queueIsEmpty();
      expect(await countWalletTransactions(wallet.id)).toBe(1);
      expect(await countInboxMessages(message.messageId)).toBe(1);
      expect(await walletState(wallet.id)).toEqual({ balance: '90.00', version: 2 });
    },
    SQS_TEST_TIMEOUT_MS,
  );
});

// ---- utilitários

/** Variáveis de ambiente valem só durante `fn` (a config do SQS é lida ao criar a app). */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface SpawnedApp {
  process: ReturnType<typeof Bun.spawn>;
  /** Linhas JSON do stdout (os logs do Nest, que não são JSON, ficam de fora). */
  logs(): Array<Record<string, unknown>>;
}

/** Sobe a app de verdade num processo filho, com o consumer ligado nas filas deste teste. */
async function spawnApp(env: Record<string, string>): Promise<SpawnedApp> {
  const child = Bun.spawn(['bun', 'src/main.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      PORT: '0',
      SQS_CONSUMER_ENABLED: 'true',
      SQS_WAGER_QUEUE_URL: queues.queueUrl,
      SQS_WAGER_DLQ_URL: queues.dlqUrl,
      SQS_WAIT_TIME_SECONDS: '1',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const lines: Array<Record<string, unknown>> = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        try {
          lines.push(JSON.parse(part));
        } catch {
          // log do Nest em texto
        }
      }
    }
  })();
  const app = { process: child, logs: () => lines };
  await waitUntil(async () => lines.some((l) => l.message === 'sqs consumer started'), Boolean, { timeoutMs: 10_000 });
  return app;
}

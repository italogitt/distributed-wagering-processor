import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work';
import { startApp, submit, transactionBody } from './support/app';
import {
  assertLedgerInvariant,
  closeDatabase,
  discardPendingOutbox,
  insertOutboxEvents,
  outboxRows,
  pendingOutboxCount,
  resetDatabase,
  seedWallet,
} from './support/database';
import { withEnv } from './support/process';
import { createPublisher, type PublisherHarness } from './support/publisher';
import { countingSqs, createEventsQueue, deleteQueue, drainQueue, sqs, waitUntil } from './support/sqs';

// Espera de backoff (2 s na 1ª falha) + long polls de 1 s na leitura da fila.
const TEST_TIMEOUT_MS = 20_000;

let eventsQueue: string;
let harnesses: PublisherHarness[] = [];

beforeAll(resetDatabase);
afterAll(closeDatabase);

beforeEach(async () => {
  eventsQueue = await createEventsQueue();
  await discardPendingOutbox();
});

afterEach(async () => {
  await Promise.all(harnesses.map((h) => h.close()));
  harnesses = [];
  await deleteQueue(eventsQueue);
  await assertLedgerInvariant();
});

async function publisher(overrides: Parameters<typeof createPublisher>[1] = {}): Promise<PublisherHarness> {
  const harness = await createPublisher(eventsQueue, overrides);
  harnesses.push(harness);
  return harness;
}

const outboxIsEmpty = () => waitUntil(pendingOutboxCount, (n) => n === 0);

test(
  'A1. transação via HTTP → eventos na fila com o envelope gravado na outbox, e published_at preenchido',
  async () => {
    const wallet = await seedWallet('100.00');
    const app = await withEnv(
      { OUTBOX_PUBLISHER_ENABLED: 'true', SQS_WALLET_EVENTS_QUEUE_URL: eventsQueue, OUTBOX_POLL_INTERVAL_MS: '100' },
      startApp,
    );
    try {
      const response = await submit(app.url, `k-${Bun.randomUUIDv7()}`, transactionBody(wallet, 'BET', '10.00'), 'req-a1');
      expect(response.body.status).toBe('PROCESSED');

      const received = await drainQueue(eventsQueue, 2);
      await outboxIsEmpty();

      const rows = await outboxRows({ walletId: wallet.id });
      expect(rows.map((r) => r.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
      for (const row of rows) {
        expect(row.publishedAt).not.toBeNull();
        const message = received.find((m) => m.body.eventId === row.id)!;
        // Corpo = envelope da outbox; grupo = aggregate; dedup = eventId.
        expect(message.body).toEqual(row.payload);
        expect(message.groupId).toBe(row.aggregateId);
        expect(message.deduplicationId).toBe(row.id);
        expect(message.body).toMatchObject({
          eventId: row.id,
          eventType: row.eventType,
          aggregateId: row.aggregateId,
          correlationId: 'req-a1',
          causationId: response.body.transactionId,
          version: 1,
          occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        });
      }
    } finally {
      await app.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  'A2. três publishers ao mesmo tempo sobre 100 eventos → todos publicados, cada eventId enviado uma vez',
  async () => {
    // 20 aggregates x 5 eventos; lote de 5: os três publishers disputam cabeças de fila diferentes.
    const aggregates = Array.from({ length: 20 }, () => crypto.randomUUID());
    const ids = await insertOutboxEvents(aggregates, 5);
    const spies = [countingSqs(), countingSqs(), countingSqs()];
    const publishers = await Promise.all(
      spies.map((spy) => publisher({ sqs: spy.client, options: { batchSize: 5, idleDelayMs: 50 } })),
    );

    for (const p of publishers) p.worker.start();
    await outboxIsEmpty();
    await Promise.all(publishers.map((p) => p.worker.stop()));

    const sent = spies.flatMap((spy) => spy.sent);
    expect(sent.toSorted()).toEqual(ids.toSorted()); // nenhum envio repetido
    expect(spies.filter((spy) => spy.sent.length > 0).length).toBeGreaterThan(1);

    const received = await drainQueue(eventsQueue, 100);
    const receivedIds = received.map((m) => String(m.body.eventId));
    expect(new Set(receivedIds).size).toBe(100);
    expect(receivedIds.toSorted()).toEqual(ids.toSorted());
  },
  TEST_TIMEOUT_MS,
);

test(
  'A3. commit feito e nenhum publisher rodando (processo morreu) → outra instância sobe e publica',
  async () => {
    const wallet = await seedWallet('100.00');
    // Instância sem publisher: confirma a transação e "morre".
    const app = await startApp();
    const response = await submit(app.url, `k-${Bun.randomUUIDv7()}`, transactionBody(wallet, 'BET', '10.00'));
    await app.close();
    expect(response.body.status).toBe('PROCESSED');
    expect(await pendingOutboxCount()).toBe(2);

    const survivor = await publisher();
    survivor.worker.start();
    await outboxIsEmpty();

    const received = await drainQueue(eventsQueue, 2);
    const rows = await outboxRows({ walletId: wallet.id });
    expect(received.map((m) => m.body.eventId).toSorted()).toEqual(rows.map((r) => r.id).toSorted());
  },
  TEST_TIMEOUT_MS,
);

test(
  'A4. falha depois do envio e antes de marcar published_at → o evento sai de novo com o mesmo eventId',
  async () => {
    const aggregateId = crypto.randomUUID();
    const [eventId] = await insertOutboxEvents([aggregateId], 1);
    const spy = countingSqs();
    let crashes = 1;
    const p = await publisher({
      sqs: spy.client,
      wrapUnitOfWork: (inner): UnitOfWork => ({
        run: (work) =>
          inner.run((repos) =>
            work({
              ...repos,
              outbox: Object.assign(Object.create(repos.outbox), {
                markPublished: async (ids: readonly string[]) => {
                  if (crashes > 0) {
                    crashes -= 1;
                    throw new Error('processo caiu antes de marcar published_at');
                  }
                  return repos.outbox.markPublished(ids);
                },
              }),
            }),
          ),
      }),
    });

    await expect(p.useCase.publishBatch()).rejects.toThrow('processo caiu');
    // Rollback: o evento continua pendente e pronto (a falha não foi do SQS, então nem conta tentativa).
    expect((await outboxRows({ aggregateId }))[0]).toMatchObject({ id: eventId, publishedAt: null, attempts: 0 });

    const results = await p.useCase.publishBatch();
    expect(results.map((r) => r.outcome)).toEqual(['published']);
    expect(spy.sent).toEqual([eventId!, eventId!]); // enviado duas vezes, mesmo MessageDeduplicationId

    // O SQS FIFO descarta o segundo envio (mesmo dedup id em 5 min): uma mensagem só.
    const received = await drainQueue(eventsQueue, 1);
    expect(received.map((m) => m.body.eventId)).toEqual([eventId]);
    expect((await outboxRows({ aggregateId }))[0]!.publishedAt).not.toBeNull();
  },
  TEST_TIMEOUT_MS,
);

test(
  'A5. SQS fora do ar → attempts sobe e next_attempt_at vai para o futuro; o SQS volta → publicado',
  async () => {
    const aggregateId = crypto.randomUUID();
    const [eventId] = await insertOutboxEvents([aggregateId], 1);
    // Nada escuta na porta 1; maxAttempts 1 para o SDK não insistir.
    const down = new SQSClient({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 1,
    });
    let sqsIsUp = false;
    const switchable = {
      send: (command: SendMessageCommand) => (sqsIsUp ? sqs : down).send(command),
    } as unknown as SQSClient;
    const p = await publisher({ sqs: switchable });

    const [failure] = await p.useCase.publishBatch();
    expect(failure).toMatchObject({ outcome: 'failed', attempts: 1, retryInSeconds: 2 });
    const [row] = await outboxRows({ aggregateId });
    expect(row).toMatchObject({ id: eventId, attempts: 1, publishedAt: null });
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(row!.lastError).toContain('ECONNREFUSED');

    // Ainda em backoff: o lote seguinte não pega o evento.
    expect(await p.useCase.publishBatch()).toEqual([]);

    sqsIsUp = true;
    const published = await waitUntil(
      () => p.useCase.publishBatch(),
      (results) => results.length > 0,
      { timeoutMs: 5_000 },
    );
    expect(published.map((r) => r.outcome)).toEqual(['published']);
    expect((await drainQueue(eventsQueue, 1)).map((m) => m.body.eventId)).toEqual([eventId]);
    expect((await outboxRows({ aggregateId }))[0]).toMatchObject({ attempts: 1, publishedAt: expect.any(Date) });
    down.destroy();
  },
  TEST_TIMEOUT_MS,
);

test(
  'A6. eventos do mesmo aggregate saem na ordem do sequence, mesmo com uma falha no meio',
  async () => {
    const [x, y] = [crypto.randomUUID(), crypto.randomUUID()];
    const ids = await insertOutboxEvents([x, y], 5); // x1, y1, x2, y2, ...
    const xIds = ids.filter((_, i) => i % 2 === 0);
    const yIds = ids.filter((_, i) => i % 2 === 1);

    // O 2º evento de x falha uma vez: os seguintes de x esperam; os de y não.
    const failOnce = new Set([xIds[1]!]);
    const flaky = {
      send: async (command: SendMessageCommand) => {
        const id = command.input.MessageDeduplicationId!;
        if (failOnce.delete(id)) throw new Error(`falha simulada em ${id}`);
        return sqs.send(command);
      },
    } as unknown as SQSClient;
    const p = await publisher({ sqs: flaky });

    p.worker.start();
    await outboxIsEmpty();
    await p.worker.stop();

    const received = await drainQueue(eventsQueue, 10);
    expect(received.filter((m) => m.groupId === x).map((m) => m.body.eventId)).toEqual(xIds);
    expect(received.filter((m) => m.groupId === y).map((m) => m.body.eventId)).toEqual(yIds);

    // A falha segurou só o aggregate x (D18): y terminou antes do retry de x2.
    const rows = [...(await outboxRows({ aggregateId: x })), ...(await outboxRows({ aggregateId: y }))];
    const publishedAt = (id: string) => rows.find((r) => r.id === id)!.publishedAt!.getTime();
    expect(publishedAt(yIds[4]!)).toBeLessThan(publishedAt(xIds[1]!));
    expect(rows.find((r) => r.id === xIds[1])).toMatchObject({ attempts: 1 });
    expect(p.logger.lines.filter((l) => l.message === 'outbox event publish failed').map((l) => l.eventId)).toEqual([
      xIds[1],
    ]);
  },
  TEST_TIMEOUT_MS,
);

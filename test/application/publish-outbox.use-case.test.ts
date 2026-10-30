import { describe, expect, test } from 'bun:test';
import { backoffSeconds } from '../../src/application/backoff';
import type { EventPublisher } from '../../src/application/ports/event-publisher';
import type { OutboxRepository, PendingOutboxEvent } from '../../src/application/ports/outbox.repository';
import type { TransactionalRepositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { PublishOutboxUseCase } from '../../src/application/use-cases/publish-outbox.use-case';

const event = (eventId: string, attempts = 0): PendingOutboxEvent => ({
  eventId,
  eventType: 'WagerTransactionProcessed',
  aggregateId: `agg-${eventId}`,
  attempts,
  payload: { eventId },
});

/** Outbox falsa: devolve os eventos dados no claim e registra o que o caso de uso gravou. */
class FakeOutbox implements Pick<OutboxRepository, 'claimPending' | 'markPublished' | 'scheduleRetry'> {
  claimedWith?: number;
  published: string[] = [];
  retries: Array<{ eventId: string; attempts: number; delaySeconds: number; error: string }> = [];

  constructor(private readonly pending: PendingOutboxEvent[]) {}

  async claimPending(limit: number) {
    this.claimedWith = limit;
    return this.pending.slice(0, limit);
  }
  async markPublished(eventIds: readonly string[]) {
    this.published.push(...eventIds);
  }
  async scheduleRetry(eventId: string, attempts: number, delaySeconds: number, error: string) {
    this.retries.push({ eventId, attempts, delaySeconds, error });
  }
}

/** UoW que entrega só a outbox (o publisher não usa os outros repositórios). */
const uowWith = (outbox: FakeOutbox): UnitOfWork => ({
  run: (work) => work({ outbox } as unknown as TransactionalRepositories),
});

class FakePublisher implements EventPublisher {
  sent: string[] = [];
  constructor(private readonly failing: ReadonlySet<string> = new Set()) {}
  async publish(e: PendingOutboxEvent) {
    if (this.failing.has(e.eventId)) throw new Error(`sqs fora: ${e.eventId}`);
    this.sent.push(e.eventId);
  }
}

const OPTIONS = { batchSize: 10, backoffMaxSeconds: 60 };

describe('backoffSeconds', () => {
  test.each([
    [1, 2],
    [2, 4],
    [5, 32],
    [6, 60],
    [20, 60],
  ])('%i tentativa(s) → %i s (teto 60)', (attempts, expected) => {
    expect(backoffSeconds(attempts, 60)).toBe(expected);
  });
});

describe('PublishOutboxUseCase', () => {
  test('publica o lote e marca todos como publicados', async () => {
    const outbox = new FakeOutbox([event('e1'), event('e2')]);
    const publisher = new FakePublisher();

    const results = await new PublishOutboxUseCase(uowWith(outbox), publisher, OPTIONS).publishBatch();

    expect(results.map((r) => r.outcome)).toEqual(['published', 'published']);
    expect(publisher.sent.sort()).toEqual(['e1', 'e2']);
    expect(outbox.published.sort()).toEqual(['e1', 'e2']);
    expect(outbox.retries).toEqual([]);
  });

  test('respeita o tamanho do lote no claim', async () => {
    const outbox = new FakeOutbox([]);
    await new PublishOutboxUseCase(uowWith(outbox), new FakePublisher(), { ...OPTIONS, batchSize: 3 }).publishBatch();
    expect(outbox.claimedWith).toBe(3);
  });

  test('falha de um evento: attempts + 1 e backoff min(2^attempts, teto); os outros seguem publicados', async () => {
    const outbox = new FakeOutbox([event('ok'), event('falha', 2)]);

    const results = await new PublishOutboxUseCase(
      uowWith(outbox),
      new FakePublisher(new Set(['falha'])),
      OPTIONS,
    ).publishBatch();

    expect(outbox.published).toEqual(['ok']);
    expect(outbox.retries).toEqual([
      { eventId: 'falha', attempts: 3, delaySeconds: 8, error: 'Error: sqs fora: falha' },
    ]);
    expect(results.find((r) => r.event.eventId === 'falha')).toMatchObject({
      outcome: 'failed',
      attempts: 3,
      retryInSeconds: 8,
    });
  });

  test('sem limite de tentativas: depois de muitas falhas o backoff fica no teto e o evento continua na fila', async () => {
    const outbox = new FakeOutbox([event('teimoso', 40)]);
    await new PublishOutboxUseCase(uowWith(outbox), new FakePublisher(new Set(['teimoso'])), OPTIONS).publishBatch();
    expect(outbox.retries).toEqual([expect.objectContaining({ attempts: 41, delaySeconds: 60 })]);
  });

  test('lote vazio não grava nada', async () => {
    const outbox = new FakeOutbox([]);
    expect(await new PublishOutboxUseCase(uowWith(outbox), new FakePublisher(), OPTIONS).publishBatch()).toEqual([]);
    expect(outbox.published).toEqual([]);
    expect(outbox.retries).toEqual([]);
  });
});

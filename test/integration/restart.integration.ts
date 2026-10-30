import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import {
  assertLedgerInvariant,
  closeDatabase,
  countByStatus,
  countInboxMessages,
  countLedgerEntries,
  countWalletTransactions,
  outboxRows,
  pendingOutboxCount,
  resetDatabase,
  type SeededWallet,
  seedWallet,
  walletState,
} from './support/database';
import { type SpawnedApp, spawnApp } from './support/process';
import {
  createEventsQueue,
  createTestQueues,
  deleteQueue,
  deleteTestQueues,
  drainQueue,
  peekDlq,
  queueDepth,
  send,
  type TestQueues,
  type WagerMessageBody,
  waitUntil,
  wagerMessage,
} from './support/sqs';

// Dois boots da app (~1-2 s cada) + visibility timeout de 3 s das mensagens que
// ficaram com a instância morta + leitura de ~130 eventos da fila.
const TEST_TIMEOUT_MS = 45_000;

const WALLETS = 4;
const BETS_PER_WALLET = 15;
const RESENT_PER_WALLET = 2;

let queues: TestQueues;
let eventsQueue: string;
const apps: SpawnedApp[] = [];

beforeAll(async () => {
  await resetDatabase();
  queues = await createTestQueues();
  eventsQueue = await createEventsQueue();
});

afterAll(async () => {
  for (const app of apps) app.process.kill('SIGKILL');
  await deleteTestQueues(queues);
  await deleteQueue(eventsQueue);
  await closeDatabase();
});

afterEach(assertLedgerInvariant);

/** App completa num processo filho: consumer + publisher + worker, com tempos curtos. */
function spawnFullApp(): Promise<SpawnedApp> {
  return spawnApp(
    {
      SQS_CONSUMER_ENABLED: 'true',
      SQS_WAGER_QUEUE_URL: queues.queueUrl,
      SQS_WAGER_DLQ_URL: queues.dlqUrl,
      SQS_WAIT_TIME_SECONDS: '1',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '3',
      OUTBOX_PUBLISHER_ENABLED: 'true',
      SQS_WALLET_EVENTS_QUEUE_URL: eventsQueue,
      OUTBOX_POLL_INTERVAL_MS: '100',
      PENDING_REFERENCE_WORKER_ENABLED: 'true',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    },
    ['sqs consumer started', 'outbox publisher started', 'pending reference worker started'],
  ).then((app) => {
    apps.push(app);
    return app;
  });
}

/**
 * Rajada de uma wallet, no grupo FIFO da wallet: um REFUND que chega ANTES
 * da BET referenciada (vira PENDING_REFERENCE e o worker resolve), 15 BETs de
 * 10.00 e 2 reenvios (mesmo messageId) que a inbox tem que barrar.
 * Efeito esperado: 1000 - 15 x 10 + 10 = 860.00.
 */
function burstFor(wallet: SeededWallet, prefix: string): WagerMessageBody[] {
  const id = (n: string) => `${prefix}${wallet.id}-${n}`;
  const refundedBet = id('bet-0');
  const refund = wagerMessage(wallet, {
    messageId: id('refund'),
    kind: 'REFUND',
    referenceExternalTransactionId: refundedBet,
  });
  const bets = Array.from({ length: BETS_PER_WALLET }, (_, n) =>
    wagerMessage(wallet, { messageId: id(`bet-${n}`), externalTransactionId: id(`bet-${n}`) }),
  );
  return [refund, ...bets, ...bets.slice(0, RESENT_PER_WALLET)];
}

test(
  'reinício: a app morre (SIGKILL) no meio da rajada; outra instância termina → efeito único, outbox publicada, saldo == ledger',
  async () => {
    const prefix = `rst-${Bun.randomUUIDv7()}-`;
    const wallets = await Promise.all(Array.from({ length: WALLETS }, () => seedWallet('1000.00')));
    const burst = wallets.flatMap((wallet) => burstFor(wallet, prefix).map((body) => ({ wallet, body })));
    for (const { wallet, body } of burst) {
      await send(queues.queueUrl, body, wallet.id);
    }
    const uniqueMessages = WALLETS * (1 + BETS_PER_WALLET);

    // 1ª instância: morre sem shutdown assim que começa a processar.
    const first = await spawnFullApp();
    await waitUntil(() => countInboxMessages(prefix), (n) => n >= 5, { intervalMs: 20 });
    first.process.kill('SIGKILL');
    await first.exited();
    const processedBeforeCrash = await countInboxMessages(prefix);
    expect(processedBeforeCrash).toBeLessThan(uniqueMessages); // morreu mesmo no meio

    // 2ª instância: recebe o resto, incluindo as que estavam com a 1ª (voltam após o visibility timeout).
    const second = await spawnFullApp();
    await waitUntil(() => countInboxMessages(prefix), (n) => n === uniqueMessages, { timeoutMs: 25_000 });
    await waitUntil(() => queueDepth(queues.queueUrl), (d) => d.visible === 0 && d.inFlight === 0, {
      timeoutMs: 15_000,
    });
    for (const wallet of wallets) {
      await waitUntil(() => countByStatus(wallet.id, 'PENDING_REFERENCE'), (n) => n === 0, { timeoutMs: 10_000 });
    }
    await waitUntil(pendingOutboxCount, (n) => n === 0, { timeoutMs: 10_000 });
    second.process.kill('SIGTERM');
    await second.exited();

    // Cada mensagem com efeito uma única vez.
    for (const wallet of wallets) {
      expect(await countWalletTransactions(wallet.id)).toBe(1 + BETS_PER_WALLET);
      expect(await countByStatus(wallet.id, 'PROCESSED')).toBe(2 + BETS_PER_WALLET); // + OPENING
      expect(await countLedgerEntries(wallet.id)).toBe(2 + BETS_PER_WALLET); // abertura + BETs + REFUND
      expect(await walletState(wallet.id)).toMatchObject({ balance: '860.00' });
    }
    expect(await peekDlq(queues.dlqUrl)).toHaveLength(0);

    // Outbox toda publicada, e cada evento chegou à fila uma vez.
    const outbox = (await Promise.all(wallets.map((w) => outboxRows({ walletId: w.id })))).flat();
    expect(outbox.every((row) => row.publishedAt !== null)).toBe(true);
    const expectedEvents = WALLETS * (BETS_PER_WALLET * 2 + 3); // BET: 2; REFUND: PendingReference + Processed + BalanceChanged
    expect(outbox).toHaveLength(expectedEvents);
    const received = await drainQueue(eventsQueue, expectedEvents, { timeoutMs: 20_000 });
    const receivedIds = received.map((m) => String(m.body.eventId));
    expect(new Set(receivedIds).size).toBe(receivedIds.length);
    expect(receivedIds.toSorted()).toEqual(outbox.map((row) => row.id).toSorted());
  },
  TEST_TIMEOUT_MS,
);

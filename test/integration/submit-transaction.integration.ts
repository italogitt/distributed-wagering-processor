import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { type RunningApp, startApp, submit, type TransactionBody } from './support/app';
import {
  assertLedgerInvariant,
  closeDatabase,
  countLedgerEntries,
  countTransactions,
  resetDatabase,
  type SeededWallet,
  seedWallet,
  walletState,
} from './support/database';

const PROVIDER = 'provider-a';

let apps: RunningApp[] = [];

beforeAll(async () => {
  await resetDatabase();
  // Três apps independentes, cada uma com o próprio MikroORM e pool de conexões.
  apps = await Promise.all([startApp(), startApp(), startApp()]);
});

afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
  await closeDatabase();
});

// O invariante roda depois de CADA teste; se falhar, o teste falha.
afterEach(assertLedgerInvariant);

const urlsOf = (count: number) => apps.slice(0, count).map((app) => app.url);

/** Distribui as requisições entre as instâncias em round-robin. */
const roundRobin = (urls: string[], index: number) => urls[index % urls.length]!;

const body = (
  wallet: SeededWallet,
  kind: string,
  amount: string,
  externalTransactionId = `ext-${Bun.randomUUIDv7()}`,
  referenceExternalTransactionId?: string,
): TransactionBody => ({
  providerId: PROVIDER,
  externalTransactionId,
  walletId: wallet.id,
  playerId: wallet.playerId,
  roundId: 'round-1',
  gameId: 'game-1',
  kind,
  money: { amount, currency: wallet.currency },
  referenceExternalTransactionId,
});

const keyOf = (b: TransactionBody) => `${b.providerId}:${b.externalTransactionId}`;

// ---- cenários reaproveitados com 1 e com 3 instâncias (teste 6)

async function fiftyIdenticalRequests(urls: string[]): Promise<void> {
  const wallet = await seedWallet('100.00');
  const bet = body(wallet, 'BET', '10.00');

  const responses = await Promise.all(
    Array.from({ length: 50 }, (_, i) => submit(roundRobin(urls, i), keyOf(bet), bet)),
  );

  // Respostas iguais; só o idempotentReplay distingue quem gravou de quem leu.
  const { idempotentReplay: _ignored, ...first } = responses[0]!.body;
  for (const { status, body: res } of responses) {
    const { idempotentReplay: _flag, ...rest } = res;
    expect(status).toBe(200);
    expect(rest).toEqual(first);
  }
  expect(first).toMatchObject({ status: 'PROCESSED', balance: { amount: '90.00', currency: 'BRL' } });
  expect(responses.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);

  expect(await countTransactions(PROVIDER, bet.externalTransactionId)).toBe(1);
  expect(await countLedgerEntries(wallet.id)).toBe(2); // abertura + 1 débito
  expect(await walletState(wallet.id)).toEqual({ balance: '90.00', version: 2 });
}

async function doubleSpend(urls: string[]): Promise<void> {
  const wallet = await seedWallet('100.00');
  const bets = [body(wallet, 'BET', '80.00'), body(wallet, 'BET', '80.00')];

  const responses = await Promise.all(bets.map((b, i) => submit(roundRobin(urls, i), keyOf(b), b)));

  for (const r of responses) expect(r.status).toBe(200);
  const processed = responses.filter((r) => r.body.status === 'PROCESSED');
  const rejected = responses.filter((r) => r.body.status === 'REJECTED');
  expect(processed).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]!.body.failureCode).toBe('INSUFFICIENT_FUNDS');
  // As duas respostas mostram o saldo real depois da decisão (a rejeitada relê).
  for (const r of responses) expect(r.body.balance).toEqual({ amount: '20.00', currency: 'BRL' });

  expect(await walletState(wallet.id)).toEqual({ balance: '20.00', version: 2 });
  expect(await countLedgerEntries(wallet.id)).toBe(2); // abertura + 1 débito
}

describe('1 instância', () => {
  test('1. 50 envios idênticos em paralelo → 50 respostas iguais, 1 transação, 1 lançamento', () =>
    fiftyIdenticalRequests(urlsOf(1)));

  test('2. saldo 100 e duas BETs de 80 em paralelo → uma PROCESSED, uma INSUFFICIENT_FUNDS, saldo 20', () =>
    doubleSpend(urlsOf(1)));

  test('3. mesma key com payload diferente → 409, sem lançamento novo', async () => {
    const [url] = urlsOf(1);
    const wallet = await seedWallet('100.00');
    const bet = body(wallet, 'BET', '10.00');

    const first = await submit(url!, keyOf(bet), bet);
    expect(first.status).toBe(200);
    const entriesBefore = await countLedgerEntries(wallet.id);

    const conflict = await submit(url!, keyOf(bet), { ...bet, money: { amount: '11.00', currency: 'BRL' } });

    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('IDEMPOTENCY_CONFLICT');
    expect(await countLedgerEntries(wallet.id)).toBe(entriesBefore);
    expect(await countTransactions(PROVIDER, bet.externalTransactionId)).toBe(1);
    expect(await walletState(wallet.id)).toEqual({ balance: '90.00', version: 2 });
  });

  test('4. REFUND e ROLLBACK da mesma BET em paralelo → só um reverte, o outro ALREADY_REVERSED', async () => {
    const [url] = urlsOf(1);
    const wallet = await seedWallet('100.00');
    const bet = body(wallet, 'BET', '30.00');
    expect((await submit(url!, keyOf(bet), bet)).body.status).toBe('PROCESSED');

    const reversals = [
      body(wallet, 'REFUND', '30.00', undefined, bet.externalTransactionId),
      body(wallet, 'ROLLBACK', '30.00', undefined, bet.externalTransactionId),
    ];
    const responses = await Promise.all(reversals.map((r) => submit(url!, keyOf(r), r)));

    for (const r of responses) expect(r.status).toBe(200);
    const processed = responses.filter((r) => r.body.status === 'PROCESSED');
    const rejected = responses.filter((r) => r.body.status === 'REJECTED');
    expect(processed).toHaveLength(1);
    expect(processed[0]!.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.body.failureCode).toBe('ALREADY_REVERSED');
    // Saldo de depois do crédito da vencedora, mesmo que o passo 4 tenha lido 70.00.
    expect(rejected[0]!.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    expect(await walletState(wallet.id)).toEqual({ balance: '100.00', version: 3 });
    expect(await countLedgerEntries(wallet.id)).toBe(3); // abertura + débito + 1 crédito
  });

  test('5. rajada mista de 200 BETs/WINs em paralelo → saldo == calculado no teste == soma do ledger', async () => {
    const [url] = urlsOf(1);
    // Saldo inicial cobre todas as BETs: nenhuma é rejeitada, então o saldo
    // final é conhecido antes de enviar, independente da ordem de chegada.
    const initialCents = 1_000_000n; // 10000.00
    const wallet = await seedWallet('10000.00');

    // Gerador com semente fixa: a mesma rajada a cada execução (reproduzível).
    const random = mulberry32(20261030);
    let expectedCents = initialCents;
    const operations = Array.from({ length: 200 }, () => {
      const kind = random() < 0.5 ? 'BET' : 'WIN';
      const cents = BigInt(1 + Math.floor(random() * 5000)); // 0.01 a 50.00
      expectedCents += kind === 'BET' ? -cents : cents;
      return body(wallet, kind, formatCents(cents));
    });

    const responses = await Promise.all(operations.map((op) => submit(url!, keyOf(op), op)));

    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('PROCESSED');
    }
    expect(await walletState(wallet.id)).toEqual({ balance: formatCents(expectedCents), version: 201 });
    expect(await countLedgerEntries(wallet.id)).toBe(201); // abertura + 200 movimentos
  });
});

describe('6. 3 instâncias em round-robin', () => {
  test('teste 1 com 3 instâncias: 50 envios idênticos → 1 transação, 1 lançamento', () =>
    fiftyIdenticalRequests(urlsOf(3)));

  test('saldo 100 e 3 BETs de 40, uma por instância → 2 PROCESSED, 1 INSUFFICIENT_FUNDS, saldo 20', async () => {
    const urls = urlsOf(3);
    const wallet = await seedWallet('100.00');
    const bets = urls.map(() => body(wallet, 'BET', '40.00'));

    const responses = await Promise.all(bets.map((b, i) => submit(urls[i]!, keyOf(b), b)));

    for (const r of responses) expect(r.status).toBe(200);
    const processed = responses.filter((r) => r.body.status === 'PROCESSED');
    const rejected = responses.filter((r) => r.body.status === 'REJECTED');
    // Os débitos são serializados no lock da wallet: o primeiro vê 60, o segundo 20.
    expect(processed.map((r) => r.body.balance?.amount).sort()).toEqual(['20.00', '60.00']);
    // A rejeição só acontece depois dos dois débitos: o saldo dela é 20.
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.body).toMatchObject({
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '20.00', currency: 'BRL' },
    });

    expect(await walletState(wallet.id)).toEqual({ balance: '20.00', version: 3 });
    expect(await countLedgerEntries(wallet.id)).toBe(3); // abertura + 2 débitos
  });
});

// ---- utilitários

/** PRNG de 32 bits com semente (mulberry32): valores "aleatórios" reproduzíveis. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 1234n → "12.34". */
function formatCents(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

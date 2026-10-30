import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { type RunningApp, startApp, submit, transactionBody } from './support/app';
import {
  assertLedgerInvariant,
  closeDatabase,
  countByStatus,
  countLedgerEntries,
  ledgerIds,
  outboxRows,
  resetDatabase,
  tamperBalance,
  walletState,
} from './support/database';

const CONCURRENCY_TIMEOUT_MS = 20_000;

let app: RunningApp;

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
});

afterEach(assertLedgerInvariant);

interface Response {
  status: number;
  body: any;
}

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${app.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

interface ApiWallet {
  id: string;
  playerId: string;
  currency: string;
}

async function createWallet(amount: string, playerId = `player-${Bun.randomUUIDv7()}`): Promise<ApiWallet> {
  const created = await api('POST', '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  expect(created.status).toBe(201);
  return { id: created.body.id, playerId, currency: 'BRL' };
}

async function bet(wallet: ApiWallet, amount = '1.00') {
  const body = transactionBody(wallet, 'BET', amount);
  const response = await submit(app.url, `${body.providerId}:${body.externalTransactionId}`, body);
  expect(response.body.status).toBe('PROCESSED');
  return { ...response.body, externalTransactionId: body.externalTransactionId };
}

/** Em lotes, para não abrir centenas de conexões HTTP de uma vez. */
async function bets(wallet: ApiWallet, count: number) {
  for (let done = 0; done < count; done += 20) {
    await Promise.all(Array.from({ length: Math.min(20, count - done) }, () => bet(wallet)));
  }
}

async function mismatches(): Promise<number> {
  const text = await (await fetch(`${app.url}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith('reconciliation_mismatches_total '));
  return Number(line?.split(' ')[1] ?? 0);
}

describe('POST /wallets', () => {
  test('saldo > 0 → 201, OPENING + CREDIT + WalletBalanceChanged; duplicada → 409', async () => {
    const playerId = `player-${Bun.randomUUIDv7()}`;
    const created = await api('POST', '/wallets', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });

    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(String),
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    const walletId = created.body.id;
    expect(await walletState(walletId)).toEqual({ balance: '1000.00', version: 1 });
    expect(await countByStatus(walletId, 'PROCESSED')).toBe(1); // a OPENING
    expect(await countLedgerEntries(walletId)).toBe(1);
    const events = await outboxRows({ walletId });
    expect(events.map((e) => e.eventType)).toEqual(['WalletBalanceChanged']);
    expect(events[0]!.payload.data).toMatchObject({
      direction: 'CREDIT',
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: 1,
    });

    const duplicate = await api('POST', '/wallets', { playerId, initialBalance: { amount: '5.00', currency: 'BRL' } });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe('WALLET_ALREADY_EXISTS');
    // Mesmo player em outra moeda é outra wallet.
    const usd = await api('POST', '/wallets', { playerId, initialBalance: { amount: '5.00', currency: 'USD' } });
    expect(usd.status).toBe(201);
  });

  test('saldo 0 → 201 sem OPENING, sem lançamento e sem evento', async () => {
    const wallet = await createWallet('0.00');

    expect(await walletState(wallet.id)).toEqual({ balance: '0.00', version: 1 });
    expect(await countByStatus(wallet.id, 'PROCESSED')).toBe(0);
    expect(await countLedgerEntries(wallet.id)).toBe(0);
    expect(await outboxRows({ walletId: wallet.id })).toHaveLength(0);
  });

  test('corpo inválido → 400', async () => {
    const response = await api('POST', '/wallets', { playerId: 'p', initialBalance: { amount: '10', currency: 'BRL' } });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('INVALID_INPUT');
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  test(
    '120 lançamentos, limit 50 → 3 páginas sem repetição nem buraco, com lançamentos novos entre as páginas',
    async () => {
      const wallet = await createWallet('1000.00');
      await bets(wallet, 119); // + a abertura = 120
      const original = await ledgerIds(wallet.id);
      expect(original).toHaveLength(120);
      const page = (cursor?: string) =>
        api('GET', `/wallets/${wallet.id}/ledger?limit=50${cursor ? `&cursor=${cursor}` : ''}`);

      const first = await page();
      await bets(wallet, 5);
      const second = await page(first.body.nextCursor);
      await bets(wallet, 5);
      const third = await page(second.body.nextCursor);

      expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
      expect([first.body.items.length, second.body.items.length, third.body.items.length]).toEqual([50, 50, 30]);
      expect(third.body.nextCursor).toBeNull();
      const seen: string[] = [first, second, third].flatMap((p) => p.body.items.map((i: { id: string }) => i.id));
      expect(new Set(seen).size).toBe(seen.length); // sem repetição
      expect(original.every((id) => seen.includes(id))).toBe(true); // sem buraco
      expect(seen).toEqual(await ledgerIds(wallet.id)); // os 10 novos no fim, na ordem
      expect(first.body.items[0]).toMatchObject({
        direction: 'CREDIT',
        money: { amount: '1000.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
      });
    },
    CONCURRENCY_TIMEOUT_MS,
  );

  test('default 50; limit > 100, cursor inválido ou de outra wallet → 400; wallet inexistente → 404', async () => {
    const wallet = await createWallet('10.00');
    const other = await createWallet('10.00');
    await bet(other);
    const otherCursor = (await api('GET', `/wallets/${other.id}/ledger?limit=1`)).body.nextCursor;

    const all = await api('GET', `/wallets/${wallet.id}/ledger`);
    expect(all.body).toEqual({ walletId: wallet.id, items: [expect.any(Object)], nextCursor: null });
    expect((await api('GET', `/wallets/${wallet.id}/ledger?limit=101`)).status).toBe(400);
    expect((await api('GET', `/wallets/${wallet.id}/ledger?limit=abc`)).status).toBe(400);
    expect((await api('GET', `/wallets/${wallet.id}/ledger?cursor=xyz`)).status).toBe(400);
    expect((await api('GET', `/wallets/${wallet.id}/ledger?cursor=${otherCursor}`)).status).toBe(400);
    expect((await api('GET', `/wallets/${Bun.randomUUIDv7()}/ledger`)).status).toBe(404);
  });
});

describe('consultas', () => {
  test('wallet e transação (por id e por provedor) → 200; inexistentes → 404', async () => {
    const wallet = await createWallet('100.00');
    const placed = await bet(wallet, '10.00');

    expect(await api('GET', `/wallets/${wallet.id}`)).toEqual({
      status: 200,
      body: { id: wallet.id, playerId: wallet.playerId, balance: { amount: '90.00', currency: 'BRL' }, version: 2 },
    });
    const byId = await api('GET', `/wagering/transactions/${placed.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: placed.transactionId,
      providerId: 'provider-a',
      externalTransactionId: placed.externalTransactionId,
      walletId: wallet.id,
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '10.00', currency: 'BRL' },
      balance: { amount: '90.00', currency: 'BRL' },
    });
    const byExternal = await api('GET', `/providers/provider-a/wagering/transactions/${placed.externalTransactionId}`);
    expect(byExternal).toEqual(byId);

    expect((await api('GET', `/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await api('GET', '/wallets/nao-e-uuid')).status).toBe(404);
    const missingTx = await api('GET', `/wagering/transactions/${Bun.randomUUIDv7()}`);
    expect(missingTx).toMatchObject({ status: 404, body: { error: 'TRANSACTION_NOT_FOUND' } });
    expect((await api('GET', '/providers/provider-a/wagering/transactions/nao-existe')).status).toBe(404);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('consistente → consistent: true e checkedEntries = lançamentos', async () => {
    const wallet = await createWallet('100.00');
    await bets(wallet, 3);

    const response = await api('POST', `/wallets/${wallet.id}/reconciliation`);

    expect(response).toEqual({
      status: 200,
      body: {
        walletId: wallet.id,
        storedBalance: { amount: '97.00', currency: 'BRL' },
        calculatedBalance: { amount: '97.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 4,
      },
    });
    expect((await api('POST', `/wallets/${Bun.randomUUIDv7()}/reconciliation`)).status).toBe(404);
  });

  test('saldo adulterado → consistent: false, difference correta, métrica +1 e saldo NÃO corrigido', async () => {
    const wallet = await createWallet('100.00');
    const before = await mismatches();
    await tamperBalance(wallet.id, '5.00');
    try {
      const response = await api('POST', `/wallets/${wallet.id}/reconciliation`);

      expect(response.body).toMatchObject({
        storedBalance: { amount: '105.00', currency: 'BRL' },
        calculatedBalance: { amount: '100.00', currency: 'BRL' },
        difference: { amount: '5.00', currency: 'BRL' },
        consistent: false,
        checkedEntries: 1,
      });
      expect(await mismatches()).toBe(before + 1);
      expect(await walletState(wallet.id)).toEqual({ balance: '105.00', version: 1 });
    } finally {
      await tamperBalance(wallet.id, '-5.00'); // desfaz, para o invariante do afterEach
    }
  });

  test(
    'em loop enquanto 100 BETs concorrem → nunca consistent: false',
    async () => {
      const wallet = await createWallet('1000.00');
      let betting = true;
      const results: Array<{ consistent: boolean; checkedEntries: number }> = [];
      const reconciling = (async () => {
        while (betting) {
          results.push((await api('POST', `/wallets/${wallet.id}/reconciliation`)).body);
        }
      })();

      await Promise.all(Array.from({ length: 100 }, () => bet(wallet)));
      betting = false;
      await reconciling;

      expect(results.length).toBeGreaterThan(1);
      expect(results.filter((r) => !r.consistent)).toEqual([]);
      // Viu estados intermediários, não só o começo e o fim.
      expect(new Set(results.map((r) => r.checkedEntries)).size).toBeGreaterThan(1);
      const final = (await api('POST', `/wallets/${wallet.id}/reconciliation`)).body;
      expect(final).toMatchObject({ consistent: true, checkedEntries: 101, storedBalance: { amount: '900.00' } });
    },
    CONCURRENCY_TIMEOUT_MS,
  );
});

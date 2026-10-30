import { describe, expect, test } from 'bun:test';
import { InvalidInputError, TransactionNotFoundError, WalletNotFoundError } from '../../src/application/errors';
import { decodeLedgerCursor, encodeLedgerCursor } from '../../src/application/ledger-cursor';
import type { LedgerEntryView, LedgerPosition, WalletReadModel } from '../../src/application/ports/wallet-read-model';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import { WalletQueries } from '../../src/application/use-cases/wallet-queries';

const WALLET = '01a18d2e-cd1d-7304-84aa-a875bbbd3393';
const POSITION: LedgerPosition = { createdAt: '2026-10-30T12:00:00.123456Z', id: '01a18d2e-cd56-73c1-9e79-b69de742984e' };
const brl = (amount: string) => ({ amount, currency: 'BRL' });

const entry = (n: number): LedgerEntryView => {
  const id = `01a18d2e-cd56-73c1-9e79-${String(n).padStart(12, '0')}`;
  return {
    id,
    transactionId: `tx-${n}`,
    direction: 'DEBIT',
    money: brl('1.00'),
    balanceBefore: brl('2.00'),
    balanceAfter: brl('1.00'),
    createdAt: '2026-10-30T12:00:00.000Z',
    position: { createdAt: `2026-10-30T12:00:00.${String(n).padStart(6, '0')}Z`, id },
  };
};

function readModel(overrides: Partial<WalletReadModel> = {}): WalletReadModel {
  const entries = Array.from({ length: 5 }, (_, n) => entry(n + 1));
  return {
    findWallet: async (id) => (id === WALLET ? { id, playerId: 'p', balance: brl('1.00'), version: 1 } : null),
    ledgerPage: async (_walletId, after, limit) =>
      entries.filter((e) => !after || e.position.createdAt > after.createdAt).slice(0, limit),
    findTransaction: async () => null,
    findTransactionByExternalId: async () => null,
    reconciliationSnapshot: async () => null,
    ...overrides,
  };
}

describe('cursor do extrato', () => {
  test('ida e volta', () => {
    expect(decodeLedgerCursor(encodeLedgerCursor(WALLET, POSITION), WALLET)).toEqual(POSITION);
  });

  test('opaco: base64url, sem caracteres que precisem de escape na URL', () => {
    expect(encodeLedgerCursor(WALLET, POSITION)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test.each([
    ['lixo', 'não-é-base64!!'],
    ['JSON que não é cursor', Buffer.from('{"a":1}').toString('base64url')],
    ['timestamp inválido', Buffer.from(JSON.stringify({ w: WALLET, t: 'ontem', i: POSITION.id })).toString('base64url')],
    ['id não UUID', Buffer.from(JSON.stringify({ w: WALLET, t: POSITION.createdAt, i: "1' or 1=1" })).toString('base64url')],
    ['de outra wallet', encodeLedgerCursor('01a18d2e-0000-7304-84aa-a875bbbd3393', POSITION)],
  ])('%s → InvalidInputError', (_case, cursor) => {
    expect(() => decodeLedgerCursor(cursor, WALLET)).toThrow(InvalidInputError);
  });
});

describe('getLedger', () => {
  test('páginas encadeadas pelo cursor, sem a posição interna na resposta', async () => {
    const queries = new WalletQueries(readModel());

    const first = await queries.getLedger({ walletId: WALLET, limit: 2 });
    const second = await queries.getLedger({ walletId: WALLET, limit: 2, cursor: first.nextCursor! });
    const third = await queries.getLedger({ walletId: WALLET, limit: 2, cursor: second.nextCursor! });

    expect([...first.items, ...second.items, ...third.items].map((i) => i.transactionId)).toEqual([
      'tx-1',
      'tx-2',
      'tx-3',
      'tx-4',
      'tx-5',
    ]);
    expect(third.nextCursor).toBeNull();
    expect(first.items[0]).not.toHaveProperty('position');
  });

  test.each([0, 101, 1.5])('limit %p → InvalidInputError', async (limit) => {
    expect(new WalletQueries(readModel()).getLedger({ walletId: WALLET, limit })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  test('wallet inexistente → WalletNotFoundError', async () => {
    expect(new WalletQueries(readModel()).getLedger({ walletId: 'outra' })).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});

test('transação inexistente → TransactionNotFoundError', async () => {
  const queries = new WalletQueries(readModel());
  expect(queries.getTransaction('x')).rejects.toBeInstanceOf(TransactionNotFoundError);
  expect(queries.getTransactionByExternalId('p', 'x')).rejects.toBeInstanceOf(TransactionNotFoundError);
});

describe('reconciliação', () => {
  const reconcile = (storedBalance: string, ledgerSum: string) =>
    new ReconcileWalletUseCase(
      readModel({
        reconciliationSnapshot: async () => ({
          storedBalance: brl(storedBalance),
          ledgerSum: brl(ledgerSum),
          checkedEntries: 42,
        }),
      }),
    ).execute(WALLET);

  test('iguais → consistent, difference 0.00', async () => {
    expect(await reconcile('975.00', '975.00')).toEqual({
      walletId: WALLET,
      storedBalance: brl('975.00'),
      calculatedBalance: brl('975.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 42,
    });
  });

  test('diferença com sinal: guardado - calculado', async () => {
    expect(await reconcile('980.00', '975.00')).toMatchObject({ difference: brl('5.00'), consistent: false });
    expect(await reconcile('970.00', '975.00')).toMatchObject({ difference: brl('-5.00'), consistent: false });
  });

  test('soma negativa (ledger corrompido) não quebra', async () => {
    expect(await reconcile('0.00', '-1.00')).toMatchObject({ calculatedBalance: brl('-1.00'), difference: brl('1.00') });
  });

  test('wallet inexistente → WalletNotFoundError', async () => {
    expect(new ReconcileWalletUseCase(readModel()).execute(WALLET)).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});

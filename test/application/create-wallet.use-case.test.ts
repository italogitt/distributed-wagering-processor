import { beforeEach, expect, test } from 'bun:test';
import { InvalidInputError, WalletAlreadyExistsError } from '../../src/application/errors';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { InMemoryStore, SequentialIds } from './in-memory-store';

let store: InMemoryStore;
let useCase: CreateWalletUseCase;

const input = (amount: string, overrides: Partial<{ playerId: string; currency: string }> = {}) => ({
  playerId: overrides.playerId ?? 'player-1',
  initialBalance: { amount, currency: overrides.currency ?? 'BRL' },
  requestId: 'req-1',
});

beforeEach(() => {
  store = new InMemoryStore();
  useCase = new CreateWalletUseCase(store, new SequentialIds());
});

test('saldo > 0 → wallet, OPENING PROCESSED, CREDIT 0 → saldo e WalletBalanceChanged, numa transação', async () => {
  const wallet = await useCase.execute(input('1000.00'));

  expect(wallet).toEqual({
    id: expect.any(String),
    playerId: 'player-1',
    balance: { amount: '1000.00', currency: 'BRL' },
    version: 1,
  });
  expect(store.runs).toBe(1);
  const [opening] = store.committed.transactions;
  expect(opening!.transaction).toMatchObject({ kind: WagerTransactionKind.Opening, status: WagerTransactionStatus.Processed });
  expect(opening!.balanceAfter?.toJSON().amount).toBe('1000.00');
  const [entry] = store.committed.ledger;
  expect(entry).toMatchObject({ direction: LedgerDirection.Credit, transactionId: opening!.transaction.id });
  expect(entry!.balanceBefore.toJSON().amount).toBe('0.00');
  const [event] = store.committed.outbox;
  expect(event).toMatchObject({
    eventType: 'WalletBalanceChanged',
    aggregateId: wallet.id,
    correlationId: 'req-1',
    causationId: opening!.transaction.id,
  });
});

test('saldo 0 → só a wallet: sem OPENING, sem lançamento, sem evento', async () => {
  const wallet = await useCase.execute(input('0.00'));

  expect(wallet.balance.amount).toBe('0.00');
  expect(store.committed.transactions).toHaveLength(0);
  expect(store.committed.ledger).toHaveLength(0);
  expect(store.committed.outbox).toHaveLength(0);
});

test('mesmo playerId + currency → WalletAlreadyExistsError; outra moeda → ok', async () => {
  await useCase.execute(input('10.00'));

  expect(useCase.execute(input('5.00'))).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  expect((await useCase.execute(input('5.00', { currency: 'USD' }))).balance.currency).toBe('USD');
});

test.each([
  ['valor fora do formato', input('10')],
  ['moeda inválida', input('10.00', { currency: 'brl' })],
  ['playerId vazio', input('10.00', { playerId: '  ' })],
])('%s → InvalidInputError, nada gravado', async (_case, bad) => {
  expect(useCase.execute(bad)).rejects.toBeInstanceOf(InvalidInputError);
  expect(store.runs).toBe(0);
});

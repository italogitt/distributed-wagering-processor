import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvalidLedgerEntryError,
  InvalidWalletError,
} from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import { type OpenWalletProps, Wallet } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const OPENED_AT = new Date('2026-10-29T12:00:00Z');
const LATER = new Date('2026-10-29T12:05:00Z');

const openProps = (initialBalance: Money, overrides: Partial<OpenWalletProps> = {}): OpenWalletProps => ({
  id: 'wallet-1',
  playerId: 'player-1',
  initialBalance,
  openingTransactionId: 'tx-open',
  openingEntryId: 'entry-open',
  at: OPENED_AT,
  ...overrides,
});

const walletWith = (balance: string, version = 3) =>
  Wallet.rehydrate({
    id: 'wallet-1',
    playerId: 'player-1',
    currency: 'BRL',
    balance: brl(balance),
    version,
    createdAt: OPENED_AT,
    updatedAt: OPENED_AT,
  });

const movement = (money: Money) => ({ entryId: 'entry-1', money, transactionId: 'tx-1', at: LATER });

describe('Wallet.open', () => {
  test('saldo 0 → version 1, sem lançamento', () => {
    const { wallet, openingEntry } = Wallet.open(openProps(brl('0.00')));
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt).toBe(OPENED_AT);
    expect(wallet.updatedAt).toBe(OPENED_AT);
    expect(openingEntry).toBeNull();
  });

  test('saldo 50.00 → version 1, lançamento CREDIT 0.00 → 50.00', () => {
    const { wallet, openingEntry } = Wallet.open(openProps(brl('50.00')));
    expect(wallet.version).toBe(1);
    expect(wallet.balance.equals(brl('50.00'))).toBe(true);

    expect(openingEntry).not.toBeNull();
    expect(openingEntry?.id).toBe('entry-open');
    expect(openingEntry?.walletId).toBe('wallet-1');
    expect(openingEntry?.transactionId).toBe('tx-open');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.money.equals(brl('50.00'))).toBe(true);
    expect(openingEntry?.balanceBefore.equals(brl('0.00'))).toBe(true);
    expect(openingEntry?.balanceAfter.equals(brl('50.00'))).toBe(true);
    expect(openingEntry?.createdAt).toBe(OPENED_AT);
  });

  test('a moeda da wallet vem do saldo inicial', () => {
    expect(Wallet.open(openProps(usd('0.00'))).wallet.currency).toBe('USD');
  });

  test.each(['', '   '])('playerId "%s" → InvalidWalletError', (playerId) => {
    expect(() => Wallet.open(openProps(brl('0.00'), { playerId }))).toThrow(InvalidWalletError);
  });

  test('saldo inicial negativo → InvalidWalletError', () => {
    expect(() => Wallet.open(openProps(brl('10.00').negate()))).toThrow(InvalidWalletError);
  });
});

describe('Wallet.debit', () => {
  test('debit 30.00 com saldo 100.00 → saldo 70.00, version +1, lançamento DEBIT 100.00 → 70.00', () => {
    const wallet = walletWith('100.00', 3);
    const entry = wallet.debit(movement(brl('30.00')));

    expect(wallet.balance.equals(brl('70.00'))).toBe(true);
    expect(wallet.version).toBe(4);
    expect(wallet.updatedAt).toBe(LATER);

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.equals(brl('30.00'))).toBe(true);
    expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
    expect(entry.balanceAfter.equals(brl('70.00'))).toBe(true);
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('tx-1');
    expect(entry.id).toBe('entry-1');
    expect(entry.createdAt).toBe(LATER);
  });

  test('debit de todo o saldo deixa 0.00', () => {
    const wallet = walletWith('20.00');
    wallet.debit(movement(brl('20.00')));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('debit 80.00 com saldo 20.00 → InsufficientBalanceError, estado inalterado', () => {
    const wallet = walletWith('20.00', 3);
    expect(() => wallet.debit(movement(brl('80.00')))).toThrow(InsufficientBalanceError);
    expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    expect(wallet.version).toBe(3);
    expect(wallet.updatedAt).toBe(OPENED_AT);
  });

  test('debit em moeda diferente → CurrencyMismatchError, estado inalterado', () => {
    const wallet = walletWith('100.00', 3);
    expect(() => wallet.debit(movement(usd('10.00')))).toThrow(CurrencyMismatchError);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(3);
  });

  test('debit de 0.00 → erro do lançamento, estado inalterado', () => {
    const wallet = walletWith('100.00', 3);
    expect(() => wallet.debit(movement(brl('0.00')))).toThrow(InvalidLedgerEntryError);
    expect(wallet.version).toBe(3);
  });
});

describe('Wallet.credit', () => {
  test('credit 25.00 com saldo 100.00 → saldo 125.00, version +1, lançamento CREDIT', () => {
    const wallet = walletWith('100.00', 3);
    const entry = wallet.credit(movement(brl('25.00')));

    expect(wallet.balance.equals(brl('125.00'))).toBe(true);
    expect(wallet.version).toBe(4);
    expect(wallet.updatedAt).toBe(LATER);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
    expect(entry.balanceAfter.equals(brl('125.00'))).toBe(true);
  });

  test('credit em moeda diferente → CurrencyMismatchError, estado inalterado', () => {
    const wallet = walletWith('100.00', 3);
    expect(() => wallet.credit(movement(usd('10.00')))).toThrow(CurrencyMismatchError);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(3);
  });

  test('credit de 0.00 → erro do lançamento, estado inalterado (version só sobe se o saldo muda)', () => {
    const wallet = walletWith('100.00', 3);
    expect(() => wallet.credit(movement(brl('0.00')))).toThrow(InvalidLedgerEntryError);
    expect(wallet.version).toBe(3);
    expect(wallet.updatedAt).toBe(OPENED_AT);
  });

  test('movimentos seguidos sobem a version um a um', () => {
    const { wallet } = Wallet.open(openProps(brl('0.00')));
    wallet.credit(movement(brl('100.00')));
    wallet.debit(movement(brl('30.00')));
    expect(wallet.version).toBe(3);
    expect(wallet.balance.equals(brl('70.00'))).toBe(true);
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstrói sem revalidar', () => {
    const wallet = walletWith('42.00', 7);
    expect(wallet.version).toBe(7);
    expect(wallet.balance.equals(brl('42.00'))).toBe(true);
  });
});

import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidLedgerEntryError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import {
  type CreateLedgerEntryProps,
  LedgerDirection,
  WalletLedgerEntry,
} from '../../src/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const AT = new Date('2026-10-29T12:00:00Z');

const props = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('30.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('70.00'),
  createdAt: AT,
  ...overrides,
});

describe('WalletLedgerEntry.create', () => {
  test('DEBIT válido: 100.00 - 30.00 = 70.00', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.equals(brl('70.00'))).toBe(true);
  });

  test('CREDIT válido: 100.00 + 30.00 = 130.00', () => {
    const entry = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceAfter: brl('130.00') }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  test('DEBIT que zera o saldo é válido', () => {
    const entry = WalletLedgerEntry.create(
      props({ balanceBefore: brl('30.00'), balanceAfter: brl('0.00') }),
    );
    expect(entry.balanceAfter.isZero()).toBe(true);
  });

  test('conta errada (100 - 30 = 60) → erro', () => {
    expect(() => WalletLedgerEntry.create(props({ balanceAfter: brl('60.00') }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  test('direção trocada (CREDIT com conta de DEBIT) → erro', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ direction: LedgerDirection.Credit })),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('valor zero → erro', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({ money: brl('0.00'), balanceAfter: brl('100.00') }),
      ),
    ).toThrow('deve ser > 0');
  });

  test('valor negativo → erro', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({ money: brl('30.00').negate(), balanceAfter: brl('130.00') }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('saldo anterior negativo → erro', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({
          direction: LedgerDirection.Credit,
          balanceBefore: brl('10.00').negate(),
          balanceAfter: brl('20.00'),
        }),
      ),
    ).toThrow('Saldo anterior negativo');
  });

  test('saldo posterior negativo → erro', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({ balanceBefore: brl('20.00'), balanceAfter: brl('10.00').negate() }),
      ),
    ).toThrow('Saldo posterior negativo');
  });

  test.each([
    ['balanceBefore', { balanceBefore: usd('100.00') }],
    ['balanceAfter', { balanceAfter: usd('70.00') }],
    ['money', { money: usd('30.00') }],
  ] as const)('moeda diferente em %s → CurrencyMismatchError', (_field, override) => {
    expect(() => WalletLedgerEntry.create(props(override))).toThrow(CurrencyMismatchError);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('não revalida, e isBalanced() refaz a conta', () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('60.00') }));
    expect(entry.isBalanced()).toBe(false);
  });

  test('isBalanced() com moedas misturadas devolve false, sem lançar', () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: usd('70.00') }));
    expect(entry.isBalanced()).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerTransactionState,
} from '../../src/domain/wager-transaction';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const AT = new Date('2026-10-29T12:00:00Z');
const LATER = new Date('2026-10-29T12:05:00Z');

const props = (overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => ({
  id: 'tx-1',
  providerId: 'provider-1',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'idem-1',
  payloadHash: 'hash-1',
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: Kind.Bet,
  money: brl('10.00'),
  createdAt: AT,
  ...overrides,
});

const create = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create(props(overrides));

const refund = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
  create({ id: 'tx-2', kind: Kind.Refund, referenceExternalTransactionId: 'ext-1', ...overrides });

const rollback = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
  create({ id: 'tx-2', kind: Kind.Rollback, referenceExternalTransactionId: 'ext-1', ...overrides });

/** Referência já gravada, no status pedido (PROCESSED por padrão). */
const stored = (overrides: Partial<WagerTransactionState> = {}) =>
  WagerTransaction.rehydrate({ ...props(), status: Status.Processed, processedAt: AT, ...overrides });

const inStatus = (status: Status, overrides: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.rehydrate({ ...props(overrides), status });

describe('WagerTransaction.create', () => {
  test('nasce PENDING, sem referência resolvida, failureCode nem processedAt', () => {
    const tx = create();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
  });

  test('LOSS com 10.00 → erro', () => {
    expect(() => create({ kind: Kind.Loss, money: brl('10.00') })).toThrow(InvalidWagerTransactionError);
  });

  test('LOSS com 0.00 é válido', () => {
    expect(create({ kind: Kind.Loss, money: brl('0.00') }).kind).toBe(Kind.Loss);
  });

  test('BET com 0.00 → erro', () => {
    expect(() => create({ money: brl('0.00') })).toThrow(InvalidWagerTransactionError);
  });

  test('REFUND sem referência → erro', () => {
    expect(() => create({ kind: Kind.Refund })).toThrow(InvalidWagerTransactionError);
  });

  test('ROLLBACK sem referência → erro', () => {
    expect(() => create({ kind: Kind.Rollback })).toThrow(InvalidWagerTransactionError);
  });

  test('BET com referência → erro', () => {
    expect(() => create({ referenceExternalTransactionId: 'ext-0' })).toThrow(InvalidWagerTransactionError);
  });

  test('WIN com ou sem referência é válido', () => {
    expect(create({ kind: Kind.Win }).referenceExternalTransactionId).toBeUndefined();
    expect(create({ kind: Kind.Win, referenceExternalTransactionId: 'ext-0' }).referenceExternalTransactionId).toBe(
      'ext-0',
    );
  });

  test('OPENING sem dados de provedor é válido', () => {
    const tx = WagerTransaction.create({
      id: 'tx-open',
      walletId: 'wallet-1',
      playerId: 'player-1',
      kind: Kind.Opening,
      money: brl('50.00'),
      createdAt: AT,
    });
    expect(tx.status).toBe(Status.Pending);
    expect(tx.providerId).toBeUndefined();
  });

  test('OPENING com dados de provedor → erro', () => {
    expect(() => create({ kind: Kind.Opening })).toThrow(InvalidWagerTransactionError);
  });

  test('BET sem um campo de provedor → erro', () => {
    expect(() => create({ gameId: undefined })).toThrow('gameId');
  });
});

describe('transições válidas', () => {
  test('PENDING → PROCESSED', () => {
    const tx = create();
    tx.markProcessed(undefined, LATER);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toBe(LATER);
  });

  test('PENDING → REJECTED', () => {
    const tx = create();
    tx.reject(FailureCode.InsufficientFunds);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('PENDING → PENDING_REFERENCE', () => {
    const tx = refund();
    tx.markPendingReference();
    expect(tx.status).toBe(Status.PendingReference);
  });

  test('PENDING → FAILED', () => {
    const tx = create();
    tx.fail(FailureCode.InvalidReference);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.InvalidReference);
  });

  test('PENDING_REFERENCE → PROCESSED, guardando o id interno da referência', () => {
    const tx = refund();
    tx.markPendingReference();
    tx.markProcessed('tx-1', LATER);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('tx-1');
  });

  test('PENDING_REFERENCE → REJECTED', () => {
    const tx = refund();
    tx.markPendingReference();
    tx.reject(FailureCode.ReferenceNotFound);
    expect(tx.status).toBe(Status.Rejected);
  });

  test('PENDING_REFERENCE → FAILED', () => {
    const tx = refund();
    tx.markPendingReference();
    tx.fail(FailureCode.ReferenceNotFound);
    expect(tx.status).toBe(Status.Failed);
  });
});

describe('transições inválidas', () => {
  test('reject em PROCESSED → InvalidTransactionStateError', () => {
    const tx = create();
    tx.markProcessed(undefined, LATER);
    expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(tx.failureCode).toBeUndefined();
  });

  test('markPendingReference em PENDING_REFERENCE → erro', () => {
    const tx = refund();
    tx.markPendingReference();
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test('markPendingReference em BET (sem referência) → erro, estado inalterado', () => {
    const tx = create();
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(tx.status).toBe(Status.Pending);
  });

  test.each([Status.Processed, Status.Rejected, Status.Failed])('%s é terminal: nenhuma transição passa', (status) => {
    const tx = inStatus(status, { kind: Kind.Refund, referenceExternalTransactionId: 'ext-0' });
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.markProcessed(undefined, LATER)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InvalidReference)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.InvalidReference)).toThrow(InvalidTransactionStateError);
  });

  test.each([Status.Pending, Status.PendingReference])('%s não é terminal', (status) => {
    expect(inStatus(status).isTerminal()).toBe(false);
  });
});

describe('markProcessed e a referência', () => {
  test('REFUND sem referenceTransactionId → erro, estado inalterado', () => {
    const tx = refund();
    expect(() => tx.markProcessed(undefined, LATER)).toThrow(InvalidTransactionStateError);
    expect(tx.status).toBe(Status.Pending);
  });

  test('BET com referenceTransactionId → erro', () => {
    expect(() => create().markProcessed('tx-0', LATER)).toThrow(InvalidTransactionStateError);
  });

  test('WIN sem referência processa sem referenceTransactionId', () => {
    const tx = create({ kind: Kind.Win });
    tx.markProcessed(undefined, LATER);
    expect(tx.referenceTransactionId).toBeUndefined();
  });
});

describe('consultas', () => {
  test('affectsBalance é false só para LOSS', () => {
    expect(create({ kind: Kind.Loss, money: brl('0.00') }).affectsBalance()).toBe(false);
    expect(create().affectsBalance()).toBe(true);
    expect(refund().affectsBalance()).toBe(true);
  });

  test('requiresReference é true para REFUND e ROLLBACK', () => {
    expect(refund().requiresReference()).toBe(true);
    expect(rollback().requiresReference()).toBe(true);
    expect(create({ kind: Kind.Win, referenceExternalTransactionId: 'ext-0' }).requiresReference()).toBe(false);
    expect(create().requiresReference()).toBe(false);
  });

  test('matchesPayload compara o hash', () => {
    expect(create().matchesPayload('hash-1')).toBe(true);
    expect(create().matchesPayload('hash-2')).toBe(false);
  });

  test('insufficientFundsCode: BET e ROLLBACK têm códigos distintos; WIN lança', () => {
    expect(create().insufficientFundsCode()).toBe(FailureCode.InsufficientFunds);
    expect(rollback().insufficientFundsCode()).toBe(FailureCode.ReversalInsufficientFunds);
    expect(() => create({ kind: Kind.Win }).insufficientFundsCode()).toThrow(InvalidTransactionStateError);
  });
});

describe('ledgerDirectionFor', () => {
  test('BET → DEBIT; WIN e REFUND → CREDIT', () => {
    expect(create().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(create({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund().ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK de BET → CREDIT', () => {
    expect(rollback().ledgerDirectionFor(stored())).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK de WIN → DEBIT', () => {
    expect(rollback().ledgerDirectionFor(stored({ kind: Kind.Win }))).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK sem referência → erro', () => {
    expect(() => rollback().ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('LOSS → erro', () => {
    expect(() => create({ kind: Kind.Loss, money: brl('0.00') }).ledgerDirectionFor()).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('checkReference', () => {
  test('caso válido → undefined', () => {
    expect(refund().checkReference(stored())).toBeUndefined();
  });

  test('ROLLBACK de WIN válido → undefined', () => {
    expect(rollback().checkReference(stored({ kind: Kind.Win }))).toBeUndefined();
  });

  test('REFUND → WIN dá INVALID_REFERENCE', () => {
    expect(refund().checkReference(stored({ kind: Kind.Win }))).toBe(FailureCode.InvalidReference);
  });

  test('WIN → REFUND dá INVALID_REFERENCE', () => {
    const win = create({ id: 'tx-2', kind: Kind.Win, referenceExternalTransactionId: 'ext-1' });
    expect(win.checkReference(stored({ kind: Kind.Refund }))).toBe(FailureCode.InvalidReference);
  });

  test('valor diferente dá AMOUNT_MISMATCH', () => {
    expect(refund({ money: brl('5.00') }).checkReference(stored())).toBe(FailureCode.AmountMismatch);
  });

  test('WIN com valor diferente da BET é válido (só reversões exigem valor igual)', () => {
    const win = create({ id: 'tx-2', kind: Kind.Win, money: brl('25.00'), referenceExternalTransactionId: 'ext-1' });
    expect(win.checkReference(stored())).toBeUndefined();
  });

  test.each([
    ['rodada', { roundId: 'round-2' }],
    ['player', { playerId: 'player-2' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['provider', { providerId: 'provider-2' }],
    ['moeda', { money: usd('10.00') }],
  ] as const)('%s diferente dá INVALID_REFERENCE', (_field, override) => {
    expect(refund().checkReference(stored(override))).toBe(FailureCode.InvalidReference);
  });

  test.each([Status.Pending, Status.Rejected, Status.Failed])('referência %s dá INVALID_REFERENCE', (status) => {
    expect(refund().checkReference(stored({ status }))).toBe(FailureCode.InvalidReference);
  });

  test('referência PENDING_REFERENCE → erro de programação', () => {
    expect(() => refund().checkReference(stored({ status: Status.PendingReference }))).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('transação sem referência (BET) → erro de programação', () => {
    expect(() => create().checkReference(stored())).toThrow(InvalidTransactionStateError);
  });
});

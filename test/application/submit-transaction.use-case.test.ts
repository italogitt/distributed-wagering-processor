import { beforeEach, describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError,
  InvalidInputError,
  UniqueViolationError,
  WalletMismatchError,
  WalletNotFoundError,
} from '../../src/application/errors';
import { computePayloadHash } from '../../src/application/payload-hash';
import {
  type SubmitTransactionInput,
  SubmitTransactionUseCase,
} from '../../src/application/use-cases/submit-transaction.use-case';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { InMemoryStore, SequentialIds } from './in-memory-store';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const OPENED_AT = new Date('2026-10-29T12:00:00Z');

let store: InMemoryStore;
let useCase: SubmitTransactionUseCase;

const givenWallet = (balance: string, overrides: { id?: string; playerId?: string } = {}) =>
  store.addWallet(
    Wallet.rehydrate({
      id: overrides.id ?? 'wallet-1',
      playerId: overrides.playerId ?? 'player-1',
      currency: 'BRL',
      balance: brl(balance),
      version: 1,
      createdAt: OPENED_AT,
      updatedAt: OPENED_AT,
    }),
  );

/** Transação já gravada (ex.: a BET que um REFUND vai referenciar). */
const givenStored = (kind: Kind, externalId: string, status = Status.Processed, amount = '10.00') =>
  store.addTransaction({
    transaction: WagerTransaction.rehydrate({
      id: `stored-${externalId}`,
      providerId: 'provider-a',
      externalTransactionId: externalId,
      idempotencyKey: `provider-a:${externalId}`,
      payloadHash: 'hash-antigo',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind,
      money: brl(amount),
      createdAt: OPENED_AT,
      status,
      processedAt: status === Status.Processed ? OPENED_AT : undefined,
    }),
    balanceAfter: status === Status.Processed ? brl('0.00') : undefined,
  });

const input = (overrides: Partial<SubmitTransactionInput> = {}): SubmitTransactionInput => {
  const externalTransactionId = overrides.externalTransactionId ?? 'tx-1';
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    requestId: 'req-1',
    providerId: 'provider-a',
    externalTransactionId,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
};

const balance = () => store.wallet('wallet-1')!.balance.toJSON().amount;
const eventTypes = () => store.committed.outbox.map((event) => event.eventType);

beforeEach(() => {
  store = new InMemoryStore();
  useCase = new SubmitTransactionUseCase(store, new SequentialIds());
});

describe('passo 1: validação de entrada (400, sem abrir transação)', () => {
  test.each([
    ['kind OPENING', { kind: Kind.Opening }],
    ['kind desconhecido', { kind: 'JACKPOT' }],
    ['valor sem 2 casas', { money: { amount: '25', currency: 'BRL' } }],
    ['moeda não suportada', { money: { amount: '10.00', currency: 'JPY' } }],
  ] as const)('%s → InvalidInputError', async (_case, override) => {
    givenWallet('100.00');
    await expect(useCase.execute(input(override))).rejects.toThrow(InvalidInputError);
    expect(store.runs).toBe(0);
  });

  test('LOSS com valor (regra do domínio) → InvalidInputError, nada gravado', async () => {
    givenWallet('100.00');
    await expect(useCase.execute(input({ kind: Kind.Loss }))).rejects.toThrow(InvalidInputError);
    expect(store.committed.transactions).toHaveLength(0);
  });
});

describe('payloadHash', () => {
  const fields = {
    providerId: 'p',
    externalTransactionId: 'e',
    walletId: 'w',
    playerId: 'pl',
    roundId: 'r',
    gameId: 'g',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
  };

  test('é o SHA-256 do JSON com chaves em ordem alfabética e referência null', () => {
    const expected = new Bun.CryptoHasher('sha256')
      .update(
        '{"amount":"10.00","currency":"BRL","externalTransactionId":"e","gameId":"g","kind":"BET",' +
          '"playerId":"pl","providerId":"p","referenceExternalTransactionId":null,"roundId":"r","walletId":"w"}',
      )
      .digest('hex');
    expect(computePayloadHash(fields)).toBe(expected);
  });

  test('campos extras (ex.: idempotencyKey) não entram no hash', () => {
    expect(computePayloadHash({ ...fields, idempotencyKey: 'k' } as typeof fields)).toBe(computePayloadHash(fields));
  });
});

describe('BET', () => {
  test('com saldo → PROCESSED, débito, 1 lançamento, eventos Processed + BalanceChanged', async () => {
    givenWallet('100.00');
    const result = await useCase.execute(input());

    expect(result.status).toBe(Status.Processed);
    expect(result.balanceAfter).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(result.idempotentReplay).toBe(false);
    expect(balance()).toBe('90.00');
    expect(store.committed.ledger).toHaveLength(1);
    expect(store.committed.ledger[0]!.direction).toBe(LedgerDirection.Debit);
    expect(store.committed.transactions[0]!.balanceAfter?.equals(brl('90.00'))).toBe(true);
    expect(eventTypes()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);

    const [processed, changed] = store.committed.outbox;
    expect(processed!.aggregateId).toBe(result.transactionId);
    expect(changed!.aggregateId).toBe('wallet-1');
    expect(processed!.correlationId).toBe('req-1');
    expect(processed!.causationId).toBe(result.transactionId);
  });

  test('sem saldo → REJECTED INSUFFICIENT_FUNDS, saldo intacto, sem lançamento', async () => {
    givenWallet('5.00');
    const result = await useCase.execute(input());

    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.balanceAfter).toEqual({ amount: '5.00', currency: 'BRL' });
    expect(balance()).toBe('5.00');
    expect(store.committed.ledger).toHaveLength(0);
    expect(eventTypes()).toEqual(['WagerTransactionRejected']);
  });
});

describe('WIN e LOSS', () => {
  test('WIN → crédito', async () => {
    givenWallet('100.00');
    const result = await useCase.execute(input({ kind: Kind.Win, money: { amount: '30.00', currency: 'BRL' } }));
    expect(result.status).toBe(Status.Processed);
    expect(balance()).toBe('130.00');
    expect(store.committed.ledger[0]!.direction).toBe(LedgerDirection.Credit);
  });

  test('LOSS → PROCESSED sem mexer no saldo; só WagerTransactionProcessed', async () => {
    givenWallet('100.00');
    const result = await useCase.execute(input({ kind: Kind.Loss, money: { amount: '0.00', currency: 'BRL' } }));
    expect(result.status).toBe(Status.Processed);
    expect(result.balanceAfter).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(store.committed.ledger).toHaveLength(0);
    expect(eventTypes()).toEqual(['WagerTransactionProcessed']);
  });
});

describe('passo 3: idempotência', () => {
  test('mesmo pedido de novo → resultado original, idempotentReplay, nada muda', async () => {
    givenWallet('100.00');
    const first = await useCase.execute(input());
    const second = await useCase.execute(input({ requestId: 'req-2' }));

    expect(second).toEqual({ ...first, idempotentReplay: true });
    expect(balance()).toBe('90.00');
    expect(store.committed.transactions).toHaveLength(1);
    expect(store.committed.ledger).toHaveLength(1);
    expect(store.committed.outbox).toHaveLength(2);
  });

  test('mesma key com valor diferente → 409, nada gravado', async () => {
    givenWallet('100.00');
    await useCase.execute(input());
    await expect(useCase.execute(input({ money: { amount: '20.00', currency: 'BRL' } }))).rejects.toThrow(
      IdempotencyConflictError,
    );
    expect(balance()).toBe('90.00');
    expect(store.committed.transactions).toHaveLength(1);
  });

  test('mesmo externalTransactionId com outra key → 409', async () => {
    givenWallet('100.00');
    await useCase.execute(input());
    await expect(useCase.execute(input({ idempotencyKey: 'outra-key' }))).rejects.toThrow(IdempotencyConflictError);
  });
});

describe('passo 4: wallet (nada gravado)', () => {
  test('inexistente → WalletNotFoundError', async () => {
    await expect(useCase.execute(input())).rejects.toThrow(WalletNotFoundError);
    expect(store.committed.transactions).toHaveLength(0);
  });

  test('de outro player → WalletMismatchError', async () => {
    givenWallet('100.00', { playerId: 'player-2' });
    await expect(useCase.execute(input())).rejects.toThrow(WalletMismatchError);
  });

  test('de outra moeda → WalletMismatchError', async () => {
    givenWallet('100.00');
    await expect(useCase.execute(input({ money: { amount: '10.00', currency: 'USD' } }))).rejects.toThrow(
      WalletMismatchError,
    );
    expect(store.committed.transactions).toHaveLength(0);
  });
});

describe('passo 6: referência', () => {
  const refund = (overrides: Partial<SubmitTransactionInput> = {}) =>
    input({ externalTransactionId: 'refund-1', kind: Kind.Refund, referenceExternalTransactionId: 'bet-1', ...overrides });

  test('REFUND de BET PROCESSED → PROCESSED, crédito, referenceTransactionId preenchido', async () => {
    givenWallet('90.00');
    givenStored(Kind.Bet, 'bet-1');
    const result = await useCase.execute(refund());

    expect(result.status).toBe(Status.Processed);
    expect(balance()).toBe('100.00');
    const stored = store.committed.transactions.find((r) => r.transaction.id === result.transactionId)!;
    expect(stored.transaction.referenceTransactionId).toBe('stored-bet-1');
  });

  test('referência ausente → PENDING_REFERENCE, next_attempt_at = agora + 1s, sem balanceAfter', async () => {
    givenWallet('90.00');
    const before = Date.now();
    const result = await useCase.execute(refund());

    expect(result).toEqual({ transactionId: result.transactionId, status: Status.PendingReference, idempotentReplay: false });
    const row = store.committed.transactions[0]!;
    expect(row.balanceAfter).toBeUndefined();
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 1_000);
    expect(row.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(eventTypes()).toEqual(['WagerTransactionPendingReference']);
    expect(balance()).toBe('90.00');
  });

  test('referência em PENDING_REFERENCE → também espera', async () => {
    givenWallet('90.00');
    givenStored(Kind.Win, 'win-1', Status.PendingReference);
    const result = await useCase.execute(
      input({ externalTransactionId: 'rb-1', kind: Kind.Rollback, referenceExternalTransactionId: 'win-1' }),
    );
    expect(result.status).toBe(Status.PendingReference);
  });

  test('valor diferente da BET → REJECTED AMOUNT_MISMATCH', async () => {
    givenWallet('90.00');
    givenStored(Kind.Bet, 'bet-1');
    const result = await useCase.execute(refund({ money: { amount: '5.00', currency: 'BRL' } }));
    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.AmountMismatch);
    expect(result.balanceAfter).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(eventTypes()).toEqual(['WagerTransactionRejected']);
  });

  test('segundo REFUND da mesma BET → REJECTED ALREADY_REVERSED', async () => {
    givenWallet('90.00');
    givenStored(Kind.Bet, 'bet-1');
    await useCase.execute(refund());
    const second = await useCase.execute(refund({ externalTransactionId: 'refund-2' }));
    expect(second.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(balance()).toBe('100.00');
  });

  test('segundo REFUND com a referência ainda ausente → ALREADY_REVERSED (não bate no índice)', async () => {
    givenWallet('90.00');
    await useCase.execute(refund());
    const second = await useCase.execute(refund({ externalTransactionId: 'refund-2' }));
    expect(second.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(store.runs).toBe(2);
  });

  test('ROLLBACK de WIN sem saldo → REJECTED REVERSAL_INSUFFICIENT_FUNDS', async () => {
    givenWallet('5.00');
    givenStored(Kind.Win, 'win-1', Status.Processed, '50.00');
    const result = await useCase.execute(
      input({
        externalTransactionId: 'rb-1',
        kind: Kind.Rollback,
        referenceExternalTransactionId: 'win-1',
        money: { amount: '50.00', currency: 'BRL' },
      }),
    );
    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(balance()).toBe('5.00');
  });
});

describe('passo 10: corrida e retry', () => {
  test('outro envio igual commita no meio → rollback, retry acha a linha e devolve replay; 1 débito', async () => {
    givenWallet('100.00');
    // Na primeira tentativa, logo antes do nosso INSERT, "outra requisição"
    // igual commita: o mesmo débito e a mesma transação.
    store.beforeInsert = (s) => {
      s.beforeInsert = undefined;
      s.committed.wallets.get('wallet-1')!.balance = brl('90.00');
      s.addTransaction({
        transaction: WagerTransaction.rehydrate({
          id: 'vencedora',
          providerId: 'provider-a',
          externalTransactionId: 'tx-1',
          idempotencyKey: 'provider-a:tx-1',
          payloadHash: computePayloadHash({ ...input(), amount: '10.00', currency: 'BRL' }),
          walletId: 'wallet-1',
          playerId: 'player-1',
          roundId: 'round-1',
          gameId: 'game-1',
          kind: Kind.Bet,
          money: brl('10.00'),
          createdAt: OPENED_AT,
          status: Status.Processed,
          processedAt: OPENED_AT,
        }),
        balanceAfter: brl('90.00'),
      });
    };

    const result = await useCase.execute(input());

    expect(store.runs).toBe(2);
    expect(result.transactionId).toBe('vencedora');
    expect(result.idempotentReplay).toBe(true);
    expect(balance()).toBe('90.00');
    expect(store.committed.transactions).toHaveLength(1);
    expect(store.committed.ledger).toHaveLength(0); // o nosso débito foi desfeito no rollback
  });

  test('violou de novo na segunda tentativa → UniqueViolationError sobe, sem loop', async () => {
    givenWallet('100.00');
    store.beforeInsert = () => {
      throw new UniqueViolationError('transactions_provider_idempotency_key_uq');
    };
    await expect(useCase.execute(input())).rejects.toThrow(UniqueViolationError);
    expect(store.runs).toBe(2);
    expect(balance()).toBe('100.00');
  });

  test('outro erro não tem retry', async () => {
    givenWallet('100.00');
    store.beforeInsert = () => {
      throw new Error('conexão caiu');
    };
    await expect(useCase.execute(input())).rejects.toThrow('conexão caiu');
    expect(store.runs).toBe(1);
  });
});

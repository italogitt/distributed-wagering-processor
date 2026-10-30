import { describe, expect, test } from 'bun:test';
import {
  ApplicationError,
  IdempotencyConflictError,
  InvalidInputError,
  WalletMismatchError,
  WalletNotFoundError,
} from '../../../src/application/errors';
import { FailureCode } from '../../../src/domain/failure-code';
import { WagerTransactionStatus as Status } from '../../../src/domain/wager-transaction';
import { httpErrorFor } from '../../../src/interfaces/http/application-error.filter';
import {
  httpStatusFor,
  parseSubmitTransactionRequest,
  toSubmitTransactionResponse,
} from '../../../src/interfaces/http/submit-transaction.http';

const headers = { idempotencyKey: 'provider-a:tx-1', requestId: 'req-1' };

const validBody = () => ({
  providerId: 'provider-a',
  externalTransactionId: 'tx-1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
});

describe('parseSubmitTransactionRequest', () => {
  test('corpo válido → input do caso de uso, com key e requestId dos headers', () => {
    expect(parseSubmitTransactionRequest(headers, validBody())).toEqual({
      ...validBody(),
      idempotencyKey: 'provider-a:tx-1',
      requestId: 'req-1',
      referenceExternalTransactionId: undefined,
    });
  });

  test('campos extras não passam para o input', () => {
    const input = parseSubmitTransactionRequest(headers, { ...validBody(), extra: 'x' });
    expect(input).not.toHaveProperty('extra');
  });

  test('referência opcional é repassada', () => {
    const input = parseSubmitTransactionRequest(headers, { ...validBody(), referenceExternalTransactionId: 'tx-0' });
    expect(input.referenceExternalTransactionId).toBe('tx-0');
  });

  test.each([undefined, '', '   '])('Idempotency-Key ausente ou vazia (%p) → InvalidInputError', (key) => {
    expect(() => parseSubmitTransactionRequest({ idempotencyKey: key, requestId: 'r' }, validBody())).toThrow(
      InvalidInputError,
    );
  });

  test.each([[null], [[]], ['texto']])('corpo que não é objeto (%p) → InvalidInputError', (body) => {
    expect(() => parseSubmitTransactionRequest(headers, body)).toThrow(InvalidInputError);
  });

  test.each(['providerId', 'externalTransactionId', 'walletId', 'playerId', 'roundId', 'gameId', 'kind'])(
    '%s ausente, vazio ou não string → InvalidInputError',
    (field) => {
      for (const value of [undefined, '', ' ', 10]) {
        expect(() => parseSubmitTransactionRequest(headers, { ...validBody(), [field]: value })).toThrow(
          InvalidInputError,
        );
      }
    },
  );

  test.each([undefined, '25.00', { amount: 25, currency: 'BRL' }, { amount: '25.00' }])(
    'money malformado (%p) → InvalidInputError',
    (money) => {
      expect(() => parseSubmitTransactionRequest(headers, { ...validBody(), money })).toThrow(InvalidInputError);
    },
  );

  test('referência enviada vazia → InvalidInputError', () => {
    expect(() =>
      parseSubmitTransactionRequest(headers, { ...validBody(), referenceExternalTransactionId: '' }),
    ).toThrow(InvalidInputError);
  });
});

describe('resposta HTTP', () => {
  const balance = { amount: '975.00', currency: 'BRL' };

  test.each([
    [Status.Processed, 200],
    [Status.Rejected, 200],
    [Status.PendingReference, 202],
  ])('%s → %i', (status, code) => {
    expect(httpStatusFor({ transactionId: 't', status, idempotentReplay: false })).toBe(code);
  });

  test('balanceAfter vira "balance" no corpo', () => {
    expect(
      toSubmitTransactionResponse({
        transactionId: 't-1',
        status: Status.Rejected,
        failureCode: FailureCode.InsufficientFunds,
        balanceAfter: balance,
        idempotentReplay: true,
      }),
    ).toEqual({
      transactionId: 't-1',
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      balance,
      idempotentReplay: true,
    });
  });
});

describe('httpErrorFor', () => {
  test.each([
    [new InvalidInputError('x'), 400, 'INVALID_INPUT'],
    [new WalletNotFoundError('w'), 404, 'WALLET_NOT_FOUND'],
    [new IdempotencyConflictError('x'), 409, 'IDEMPOTENCY_CONFLICT'],
    [new WalletMismatchError('x'), 422, 'WALLET_MISMATCH'],
  ])('%p → %i', (error, status, code) => {
    expect(httpErrorFor(error)).toEqual({ status, code });
  });

  test('ApplicationError sem mapeamento → 500', () => {
    class Unmapped extends ApplicationError {}
    expect(httpErrorFor(new Unmapped('x')).status).toBe(500);
  });
});

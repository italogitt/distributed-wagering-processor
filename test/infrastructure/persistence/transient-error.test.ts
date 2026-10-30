import { describe, expect, test } from 'bun:test';
import {
  CheckConstraintViolationException,
  ConnectionException,
  DeadlockException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { isTransientDatabaseError } from '../../../src/infrastructure/persistence/transient-error';

const withCode = (code: string, message = 'x') => Object.assign(new Error(message), { code });

describe('isTransientDatabaseError', () => {
  test.each([
    ['ConnectionException', new ConnectionException(new Error('down'))],
    ['DeadlockException', new DeadlockException(withCode('40P01'))],
    ['ECONNREFUSED', withCode('ECONNREFUSED')],
    ['AggregateError com ECONNREFUSED (IPv4 + IPv6)', new AggregateError([withCode('ECONNREFUSED'), withCode('ECONNREFUSED')])],
    ['57P01 (admin shutdown)', withCode('57P01')],
    ['53300 (conexões esgotadas)', withCode('53300')],
    ['57014 (statement timeout)', withCode('57014')],
    ['pg: Connection terminated', new Error('Connection terminated unexpectedly')],
    ['pg pool: timeout ao conectar', new Error('timeout exceeded when trying to connect')],
  ])('%s → transitório', (_case, error) => {
    expect(isTransientDatabaseError(error)).toBe(true);
  });

  test.each([
    ['UNIQUE', new UniqueConstraintViolationException(withCode('23505'))],
    ['CHECK', new CheckConstraintViolationException(withCode('23514'))],
    ['erro genérico', new Error('bug')],
    ['não é Error', 'texto'],
  ])('%s → não transitório', (_case, error) => {
    expect(isTransientDatabaseError(error)).toBe(false);
  });
});

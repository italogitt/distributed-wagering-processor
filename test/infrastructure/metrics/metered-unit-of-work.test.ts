import { expect, test } from 'bun:test';
import { TransientInfrastructureError, UniqueViolationError } from '../../../src/application/errors';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { MeteredUnitOfWork } from '../../../src/infrastructure/metrics/metered-unit-of-work';
import { NOOP_METRICS } from '../../../src/infrastructure/metrics/metrics';

function setup(failWith?: Error) {
  let conflicts = 0;
  const inner = {
    run: async <T>(work: (repos: never) => Promise<T>) => {
      if (failWith) throw failWith;
      return work(undefined as never);
    },
  } as UnitOfWork;
  const uow = new MeteredUnitOfWork(inner, { ...NOOP_METRICS, uniqueViolation: () => (conflicts += 1) });
  return { uow, conflicts: () => conflicts };
}

test('UniqueViolation → conta e repassa o mesmo erro', async () => {
  const error = new UniqueViolationError('wager_transactions_idempotency_key_uq');
  const { uow, conflicts } = setup(error);

  await expect(uow.run(async () => 'x')).rejects.toBe(error);
  expect(conflicts()).toBe(1);
});

test('outros erros e sucesso → não conta', async () => {
  const failing = setup(new TransientInfrastructureError('timeout'));
  await expect(failing.uow.run(async () => 'x')).rejects.toBeInstanceOf(TransientInfrastructureError);

  const ok = setup();
  expect(await ok.uow.run(async () => 'x')).toBe('x');
  expect(failing.conflicts() + ok.conflicts()).toBe(0);
});

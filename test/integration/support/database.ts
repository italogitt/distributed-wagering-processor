import './env';
import { expect } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../../src/domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../../src/domain/wager-transaction';
import { Wallet } from '../../../src/domain/wallet';
import { LedgerEntryRecord } from '../../../src/infrastructure/persistence/entities/ledger-entry.record';
import { TransactionRecord } from '../../../src/infrastructure/persistence/entities/transaction.record';
import { WalletRecord } from '../../../src/infrastructure/persistence/entities/wallet.record';
import { toTransactionRow } from '../../../src/infrastructure/persistence/mappers/transaction.mapper';
import config from '../../../src/infrastructure/persistence/mikro-orm.config';

/** Conexão dos helpers (seed e asserts). As apps sob teste têm os próprios pools. */
let orm: MikroORM | undefined;

const db = () => {
  if (!orm) throw new Error('Chame resetDatabase() antes');
  return orm.em.fork();
};

/**
 * Config dos testes: sem snapshot. Com `snapshot: true`, o migrator grava
 * `.snapshot-<banco>.json` na pasta de migrations, e o banco aqui é o da
 * execução (nome aleatório). O snapshot só importa para gerar migrations no dev.
 */
const testConfig = { ...config, migrations: { ...config.migrations, snapshot: false } };

/**
 * D14: recria o schema e roda as migrations. TRUNCATE não serve, porque o
 * ledger recusa. O banco é criado pelo preload (setup.ts).
 */
export async function resetDatabase(): Promise<void> {
  if (process.env.TEST_RUN_DATABASE_READY !== 'true') {
    throw new Error('Banco da execução não criado: rode via `bun run test:integration` (preload setup.ts)');
  }
  orm = await MikroORM.init(testConfig);
  await orm.em.execute('drop schema public cascade');
  await orm.em.execute('create schema public');
  await orm.migrator.up();
}

export async function closeDatabase(): Promise<void> {
  await orm?.close();
  orm = undefined;
}

export interface SeededWallet {
  id: string;
  playerId: string;
  currency: string;
}

/**
 * Cria a wallet já com o lançamento de abertura no ledger, na mesma transação
 * SQL: wallet, transação OPENING (PROCESSED) e lançamento CREDIT 0 → saldo.
 * Assim nenhum teste começa com uma wallet cujo saldo não está no ledger.
 */
export async function seedWallet(amount: string, currency = 'BRL'): Promise<SeededWallet> {
  const initialBalance = Money.from({ amount, currency });
  if (!initialBalance.isPositive()) {
    // A OPENING exige valor > 0 (transactions_amount_by_kind_chk).
    throw new Error('seedWallet exige saldo inicial > 0');
  }
  const at = new Date();
  const playerId = `player-${Bun.randomUUIDv7()}`;
  const opening = WagerTransaction.create({
    id: Bun.randomUUIDv7(),
    walletId: Bun.randomUUIDv7(),
    playerId,
    kind: WagerTransactionKind.Opening,
    money: initialBalance,
    createdAt: at,
  });
  opening.markProcessed(undefined, at);
  const { wallet, openingEntry } = Wallet.open({
    id: opening.walletId,
    playerId,
    initialBalance,
    openingTransactionId: opening.id,
    openingEntryId: Bun.randomUUIDv7(),
    at,
  });
  if (!openingEntry) throw new Error('saldo > 0 sempre gera lançamento de abertura');

  await db().transactional(async (em) => {
    await em.insert(WalletRecord, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
    await em.insert(TransactionRecord, toTransactionRow({ transaction: opening, balanceAfter: initialBalance }));
    await em.insert(LedgerEntryRecord, {
      id: openingEntry.id,
      walletId: openingEntry.walletId,
      transactionId: openingEntry.transactionId,
      direction: openingEntry.direction,
      amount: openingEntry.money.toJSON().amount,
      currency: openingEntry.money.currency,
      balanceBefore: openingEntry.balanceBefore.toJSON().amount,
      balanceAfter: openingEntry.balanceAfter.toJSON().amount,
      createdAt: openingEntry.createdAt,
    });
  });
  return { id: wallet.id, playerId, currency };
}

/**
 * Para TODAS as wallets: saldo == soma do ledger (CREDIT soma, DEBIT subtrai).
 * A conta é feita em `numeric` no próprio Postgres, sem passar por number.
 */
export async function assertLedgerInvariant(): Promise<void> {
  const broken = await db().execute(`
    select w.id, w.balance::text as balance,
           coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::text as ledger
    from wallets w
    left join ledger_entries l on l.wallet_id = w.id
    group by w.id, w.balance
    having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)`);
  expect(broken).toEqual([]);
}

export async function walletState(walletId: string): Promise<{ balance: string; version: number }> {
  const [row] = await db().execute('select balance::text as balance, version from wallets where id = ?', [walletId]);
  if (!row) throw new Error(`wallet ${walletId} não existe`);
  return { balance: row.balance, version: row.version };
}

export async function countLedgerEntries(walletId: string): Promise<number> {
  const [row] = await db().execute('select count(*)::int as n from ledger_entries where wallet_id = ?', [walletId]);
  return row?.n ?? 0;
}

export async function countTransactions(providerId: string, externalTransactionId: string): Promise<number> {
  const [row] = await db().execute(
    'select count(*)::int as n from transactions where provider_id = ? and external_transaction_id = ?',
    [providerId, externalTransactionId],
  );
  return row?.n ?? 0;
}

/** Transações vindas do provedor (sem a OPENING do seed). */
export async function countWalletTransactions(walletId: string): Promise<number> {
  const [row] = await db().execute(
    "select count(*)::int as n from transactions where wallet_id = ? and kind <> 'OPENING'",
    [walletId],
  );
  return row?.n ?? 0;
}

export async function countInboxMessages(messageIdPrefix: string): Promise<number> {
  const [row] = await db().execute('select count(*)::int as n from inbox_messages where message_id like ?', [
    `${messageIdPrefix}%`,
  ]);
  return row?.n ?? 0;
}

export async function countOutboxEvents(walletId: string): Promise<number> {
  const [row] = await db().execute(
    "select count(*)::int as n from outbox_events where payload->'data'->>'walletId' = ?",
    [walletId],
  );
  return row?.n ?? 0;
}

/**
 * Trava a linha da wallet numa transação aberta (SELECT ... FOR UPDATE): o
 * UPDATE do caso de uso fica esperando até `release()`. Serve para manter uma
 * mensagem "em andamento" de propósito.
 */
export async function lockWallet(walletId: string): Promise<{ release(): Promise<void> }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const transaction = db().transactional(async (em) => {
    await em.execute('select id from wallets where id = ? for update', [walletId]);
    locked();
    await released;
  });
  await isLocked;
  return {
    release: async () => {
      release();
      await transaction;
    },
  };
}

// ---- outbox

/** Marca como publicados os pendentes que sobraram: o publisher pega a outbox inteira, não só a do teste. */
export async function discardPendingOutbox(): Promise<void> {
  await db().execute('update outbox_events set published_at = now() where published_at is null');
}

export async function pendingOutboxCount(): Promise<number> {
  const [row] = await db().execute('select count(*)::int as n from outbox_events where published_at is null');
  return row?.n ?? 0;
}

export interface OutboxRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  publishedAt: Date | null;
  nextAttemptAt: Date;
  lastError: string | null;
}

/** Linhas da outbox em ordem de `sequence`, filtradas por aggregate ou pelo walletId do payload. */
export async function outboxRows(filter: { aggregateId?: string; walletId?: string } = {}): Promise<OutboxRow[]> {
  const rows = await db().execute(
    `select id, aggregate_id, event_type, payload, attempts, published_at, next_attempt_at, last_error
     from outbox_events
     where (?::uuid is null or aggregate_id = ?::uuid) and (?::text is null or payload->'data'->>'walletId' = ?)
     order by sequence`,
    [filter.aggregateId ?? null, filter.aggregateId ?? null, filter.walletId ?? null, filter.walletId ?? null],
  );
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    aggregateId: r.aggregate_id as string,
    eventType: r.event_type as string,
    payload: r.payload as Record<string, unknown>,
    attempts: r.attempts as number,
    publishedAt: r.published_at === null ? null : new Date(r.published_at as string),
    nextAttemptAt: new Date(r.next_attempt_at as string),
    lastError: r.last_error as string | null,
  }));
}

/**
 * Grava eventos direto na outbox, `perAggregate` por aggregate, intercalando
 * os aggregates (a1, a2, ..., a1, a2, ...): a ordem global de `sequence`
 * mistura os grupos, como no tráfego real. Devolve os ids na ordem de gravação.
 */
export async function insertOutboxEvents(aggregateIds: string[], perAggregate: number): Promise<OutboxRow['id'][]> {
  const ids: string[] = [];
  await db().transactional(async (em) => {
    for (let round = 0; round < perAggregate; round += 1) {
      for (const aggregateId of aggregateIds) {
        const eventId = Bun.randomUUIDv7();
        const payload = {
          eventId,
          eventType: 'WalletBalanceChanged',
          aggregateId,
          correlationId: `test-${eventId}`,
          occurredAt: new Date().toISOString(),
          version: 1,
          data: { round },
        };
        await em.execute(
          `insert into outbox_events (id, aggregate_type, aggregate_id, event_type, payload)
           values (?, 'wallet', ?, 'WalletBalanceChanged', ?::jsonb)`,
          [eventId, aggregateId, JSON.stringify(payload)],
        );
        ids.push(eventId);
      }
    }
  });
  return ids;
}

// ---- transactions

/** Linha crua da tabela `transactions` (colunas em snake_case, valores como o driver devolve). */
export async function transactionRow(transactionId: string): Promise<Record<string, unknown>> {
  const [row] = await db().execute(
    `select *, amount::text as amount, balance_after::text as balance_after,
            next_attempt_at::text as next_attempt_at_text
     from transactions where id = ?`,
    [transactionId],
  );
  if (!row) throw new Error(`transação ${transactionId} não existe`);
  return row;
}

export async function countByStatus(walletId: string, status: string): Promise<number> {
  const [row] = await db().execute('select count(*)::int as n from transactions where wallet_id = ? and status = ?', [
    walletId,
    status,
  ]);
  return row?.n ?? 0;
}

/** Tira da fila do worker as PENDING_REFERENCE que sobraram: o worker pega a tabela inteira, não só as do teste. */
export async function parkPendingReferences(): Promise<void> {
  await db().execute(
    "update transactions set next_attempt_at = 'infinity' where status = 'PENDING_REFERENCE'",
  );
}

/** Ids do extrato na ordem da API: (created_at, id). */
export async function ledgerIds(walletId: string): Promise<string[]> {
  const rows = await db().execute('select id from ledger_entries where wallet_id = ? order by created_at, id', [
    walletId,
  ]);
  return rows.map((r) => r.id as string);
}

/** Adultera o saldo sem lançamento (só para o teste de reconciliação; o teste desfaz no fim). */
export async function tamperBalance(walletId: string, delta: string): Promise<void> {
  await db().execute('update wallets set balance = balance + ?::numeric where id = ?', [delta, walletId]);
}

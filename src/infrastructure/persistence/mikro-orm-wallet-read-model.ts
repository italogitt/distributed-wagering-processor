import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  LedgerEntryView,
  LedgerPosition,
  ReconciliationSnapshot,
  TransactionView,
  WalletReadModel,
  WalletView,
} from '../../application/ports/wallet-read-model';
import { Money, type MoneyProps } from '../../domain/money';

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Posição com microssegundos: o Date do JS perderia precisão e o cursor pularia ou repetiria linhas.
const LEDGER_COLUMNS = `
  id, transaction_id, direction, amount::text as amount, currency,
  balance_before::text as balance_before, balance_after::text as balance_after, created_at,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as position_at`;

// Usa o índice ledger_entries_wallet_cursor_idx (wallet_id, created_at, id).
const LEDGER_FIRST_PAGE_SQL = `
  select ${LEDGER_COLUMNS} from ledger_entries
  where wallet_id = ?
  order by created_at, id
  limit ?`;

const LEDGER_NEXT_PAGE_SQL = `
  select ${LEDGER_COLUMNS} from ledger_entries
  where wallet_id = ? and (created_at, id) > (?::timestamptz, ?::uuid)
  order by created_at, id
  limit ?`;

const TRANSACTION_COLUMNS = `
  id, provider_id, external_transaction_id, wallet_id, player_id, round_id, game_id, kind, status,
  amount::text as amount, currency, failure_code, reference_external_transaction_id,
  reference_transaction_id, balance_after::text as balance_after, created_at, processed_at`;

// Um único SELECT: em READ COMMITTED cada comando enxerga um snapshot só, então
// o saldo e a soma vêm do mesmo instante. Débito e lançamento commitam juntos,
// logo uma BET concorrente aparece nos dois ou em nenhum.
const RECONCILIATION_SQL = `
  select w.balance::text as stored_balance, w.currency,
         coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::text as ledger_sum,
         count(l.id)::int as checked_entries
  from wallets w
  left join ledger_entries l on l.wallet_id = w.id
  where w.id = ?
  group by w.id`;

type Row = Record<string, any>;

const money = (amount: string, currency: string): MoneyProps => Money.from({ amount, currency }).toJSON();
const optional = <T>(value: T | null): T | undefined => value ?? undefined;

/** Leituras da seção 9, cada uma num EntityManager novo e fora de transação de escrita. */
export class MikroOrmWalletReadModel implements WalletReadModel {
  constructor(private readonly em: EntityManager) {}

  async findWallet(walletId: string): Promise<WalletView | null> {
    if (!UUID_FORMAT.test(walletId)) return null;
    const [row] = await this.query(
      'select id, player_id, balance::text as balance, currency, version from wallets where id = ?',
      [walletId],
    );
    return row
      ? { id: row.id, playerId: row.player_id, balance: money(row.balance, row.currency), version: row.version }
      : null;
  }

  async ledgerPage(walletId: string, after: LedgerPosition | undefined, limit: number): Promise<LedgerEntryView[]> {
    const rows = after
      ? await this.query(LEDGER_NEXT_PAGE_SQL, [walletId, after.createdAt, after.id, limit])
      : await this.query(LEDGER_FIRST_PAGE_SQL, [walletId, limit]);
    return rows.map((row) => ({
      id: row.id,
      transactionId: row.transaction_id,
      direction: row.direction,
      money: money(row.amount, row.currency),
      balanceBefore: money(row.balance_before, row.currency),
      balanceAfter: money(row.balance_after, row.currency),
      createdAt: new Date(row.created_at).toISOString(),
      position: { createdAt: row.position_at, id: row.id },
    }));
  }

  async findTransaction(transactionId: string): Promise<TransactionView | null> {
    if (!UUID_FORMAT.test(transactionId)) return null;
    const [row] = await this.query(`select ${TRANSACTION_COLUMNS} from transactions where id = ?`, [transactionId]);
    return row ? toTransactionView(row) : null;
  }

  async findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView | null> {
    const [row] = await this.query(
      `select ${TRANSACTION_COLUMNS} from transactions where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    return row ? toTransactionView(row) : null;
  }

  async reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | null> {
    if (!UUID_FORMAT.test(walletId)) return null;
    const [row] = await this.query(RECONCILIATION_SQL, [walletId]);
    if (!row) return null;
    return {
      // O CHECK impede saldo negativo, mas a soma de um ledger corrompido pode ser.
      storedBalance: { amount: row.stored_balance, currency: row.currency },
      ledgerSum: { amount: row.ledger_sum, currency: row.currency },
      checkedEntries: row.checked_entries,
    };
  }

  private query(sql: string, params: unknown[]): Promise<Row[]> {
    return this.em.fork().execute(sql, params);
  }
}

function toTransactionView(row: Row): TransactionView {
  return {
    transactionId: row.id,
    providerId: optional(row.provider_id),
    externalTransactionId: optional(row.external_transaction_id),
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: optional(row.round_id),
    gameId: optional(row.game_id),
    kind: row.kind,
    status: row.status,
    money: money(row.amount, row.currency),
    failureCode: optional(row.failure_code),
    referenceExternalTransactionId: optional(row.reference_external_transaction_id),
    referenceTransactionId: optional(row.reference_transaction_id),
    balance: row.balance_after === null ? undefined : money(row.balance_after, row.currency),
    createdAt: new Date(row.created_at).toISOString(),
    processedAt: row.processed_at === null ? undefined : new Date(row.processed_at).toISOString(),
  };
}

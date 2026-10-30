import { DeferMode } from '@mikro-orm/core';
import { Check, Entity, Index, ManyToOne, PrimaryKey, Property, Trigger, Unique } from '@mikro-orm/decorators/legacy';
import { TransactionRecord } from './transaction.record';
import { WalletRecord } from './wallet.record';

/**
 * Modelo de persistência da tabela `ledger_entries`. Não é a entidade de domínio
 * (`WalletLedgerEntry`): só espelha o schema.
 *
 * O ledger é insert-only. Os triggers abaixo fazem o próprio banco recusar
 * UPDATE, DELETE e TRUNCATE, então nem um bug na aplicação nem um comando manual
 * conseguem reescrever o histórico.
 */
@Entity({ tableName: 'ledger_entries' })
// No máximo um lançamento por transação em cada wallet.
@Unique({ name: 'ledger_entries_wallet_transaction_uq', properties: ['walletId', 'transactionId'] })
// Cursor do GET /wallets/:id/ledger: ordena por (created_at, id) dentro da wallet.
@Index({ name: 'ledger_entries_wallet_cursor_idx', properties: ['walletId', 'createdAt', 'id'] })
@Check({ name: 'ledger_entries_direction_chk', expression: "direction in ('DEBIT', 'CREDIT')" })
@Check({ name: 'ledger_entries_amount_positive_chk', expression: 'amount > 0' })
@Check({ name: 'ledger_entries_currency_iso4217_chk', expression: "currency ~ '^[A-Z]{3}$'" })
@Check({ name: 'ledger_entries_balance_before_non_negative_chk', expression: 'balance_before >= 0' })
@Check({ name: 'ledger_entries_balance_after_non_negative_chk', expression: 'balance_after >= 0' })
// A aritmética do lançamento: antes ± valor = depois.
@Check({
  name: 'ledger_entries_balanced_chk',
  expression:
    "(direction = 'CREDIT' and balance_after = balance_before + amount)" +
    " or (direction = 'DEBIT' and balance_after = balance_before - amount)",
})
@Trigger({
  name: 'no_update_delete_trg',
  timing: 'before',
  events: ['update', 'delete'],
  forEach: 'row',
  body: "raise exception 'ledger_entries is append-only: % is not allowed', TG_OP;",
})
// O trigger de TRUNCATE fica escrito à mão na migration create_ledger_entries:
// o MikroORM lê triggers pela information_schema.triggers, que não lista TRUNCATE,
// então declarado aqui ele apareceria como "faltando" em todo migration:check.
export class LedgerEntryRecord {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  // Sem índice próprio: o unique e o índice do cursor já começam por wallet_id.
  @ManyToOne(() => WalletRecord, {
    mapToPk: true,
    fieldName: 'wallet_id',
    deleteRule: 'restrict',
    updateRule: 'restrict',
  })
  walletId!: string;

  // DEFERRED: o lançamento é gravado antes da linha da transação, na mesma
  // transação SQL; a FK é conferida no COMMIT.
  @Index({ name: 'ledger_entries_transaction_id_idx' })
  @ManyToOne(() => TransactionRecord, {
    mapToPk: true,
    fieldName: 'transaction_id',
    deleteRule: 'restrict',
    updateRule: 'restrict',
    deferMode: DeferMode.INITIALLY_DEFERRED,
  })
  transactionId!: string;

  @Property({ type: 'text' })
  direction!: string;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'text' })
  currency!: string;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  balanceBefore!: string;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  balanceAfter!: string;

  @Property({ type: 'datetime', columnType: 'timestamptz', defaultRaw: 'now()' })
  createdAt!: Date;
}

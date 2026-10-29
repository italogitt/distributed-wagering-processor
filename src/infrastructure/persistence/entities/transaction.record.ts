import { Check, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';
import { WalletRecord } from './wallet.record';

/**
 * Modelo de persistência da tabela `transactions`. Não é a entidade de domínio
 * (`WagerTransaction`): só espelha o schema. As regras de transição ficam no
 * domínio; aqui os CHECKs garantem que nenhuma combinação inválida de
 * kind/status/colunas chegue ao banco, mesmo por um bug na aplicação.
 *
 * Também é a tabela de idempotência: não existe tabela separada.
 */
@Entity({ tableName: 'transactions' })
@Unique({ name: 'transactions_provider_external_id_uq', properties: ['providerId', 'externalTransactionId'] })
@Unique({ name: 'transactions_provider_idempotency_key_uq', properties: ['providerId', 'idempotencyKey'] })
// Uma transação só pode ser revertida uma vez no total (REFUND ou ROLLBACK).
// Reversões REJECTED/FAILED não contam, para não bloquear uma nova tentativa válida.
@Unique({
  name: 'transactions_single_reversal_uq',
  properties: ['providerId', 'referenceExternalTransactionId'],
  where: "kind in ('REFUND', 'ROLLBACK') and status not in ('REJECTED', 'FAILED')",
})
// Fila do worker que reprocessa referências ausentes.
@Index({
  name: 'transactions_pending_reference_next_attempt_idx',
  properties: ['nextAttemptAt'],
  where: "status = 'PENDING_REFERENCE'",
})
@Check({
  name: 'transactions_kind_chk',
  expression: "kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')",
})
@Check({
  name: 'transactions_status_chk',
  expression: "status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')",
})
@Check({ name: 'transactions_player_id_not_blank_chk', expression: 'length(btrim(player_id)) > 0' })
@Check({ name: 'transactions_currency_iso4217_chk', expression: "currency ~ '^[A-Z]{3}$'" })
// LOSS não mexe no saldo, então vem com valor 0. Todo o resto movimenta dinheiro.
@Check({
  name: 'transactions_amount_by_kind_chk',
  expression: "(kind = 'LOSS' and amount = 0) or (kind <> 'LOSS' and amount > 0)",
})
// OPENING é interna e não tem dados de provedor; todas as outras precisam deles.
@Check({
  name: 'transactions_provider_fields_chk',
  expression:
    "kind = 'OPENING' or (provider_id is not null and external_transaction_id is not null" +
    ' and idempotency_key is not null and payload_hash is not null' +
    ' and round_id is not null and game_id is not null)',
})
@Check({ name: 'transactions_opening_processed_chk', expression: "kind <> 'OPENING' or status = 'PROCESSED'" })
// Referência: obrigatória em REFUND/ROLLBACK, opcional em WIN, proibida no resto.
@Check({
  name: 'transactions_reference_required_chk',
  expression: "kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null",
})
@Check({
  name: 'transactions_reference_forbidden_chk',
  expression: "kind not in ('OPENING', 'BET', 'LOSS') or reference_external_transaction_id is null",
})
// O id interno da referência só existe depois de resolvida, ou seja, em PROCESSED.
@Check({
  name: 'transactions_reference_resolved_chk',
  expression:
    "(status = 'PROCESSED' and reference_external_transaction_id is not null) = (reference_transaction_id is not null)",
})
@Check({
  name: 'transactions_failure_code_chk',
  expression: "(status in ('REJECTED', 'FAILED')) = (failure_code is not null)",
})
@Check({ name: 'transactions_processed_at_chk', expression: "(status = 'PROCESSED') = (processed_at is not null)" })
// Saldo observado no momento da decisão, devolvido no replay.
@Check({
  name: 'transactions_balance_after_chk',
  expression: "(status in ('PROCESSED', 'REJECTED')) = (balance_after is not null)",
})
@Check({ name: 'transactions_balance_after_non_negative_chk', expression: 'balance_after >= 0' })
@Check({
  name: 'transactions_next_attempt_at_chk',
  expression: "(status = 'PENDING_REFERENCE') = (next_attempt_at is not null)",
})
@Check({ name: 'transactions_attempts_non_negative_chk', expression: 'attempts >= 0' })
export class TransactionRecord {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  // `mapToPk`: a propriedade guarda só o id (string), sem carregar a WalletRecord.
  // O Postgres não indexa FK sozinho, então o índice é explícito.
  @Index({ name: 'transactions_wallet_id_idx' })
  @ManyToOne(() => WalletRecord, {
    mapToPk: true,
    fieldName: 'wallet_id',
    deleteRule: 'restrict',
    updateRule: 'restrict',
  })
  walletId!: string;

  @Property({ type: 'text' })
  playerId!: string;

  @Property({ type: 'text' })
  kind!: string;

  @Property({ type: 'text' })
  status!: string;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'text' })
  currency!: string;

  // Campos do provedor: nulos só na OPENING (ver transactions_provider_fields_chk).
  @Property({ type: 'text', nullable: true })
  providerId!: string | null;

  @Property({ type: 'text', nullable: true })
  externalTransactionId!: string | null;

  @Property({ type: 'text', nullable: true })
  idempotencyKey!: string | null;

  @Property({ type: 'text', nullable: true })
  payloadHash!: string | null;

  @Property({ type: 'text', nullable: true })
  roundId!: string | null;

  @Property({ type: 'text', nullable: true })
  gameId!: string | null;

  // Id no provedor. Não é FK: a transação referenciada pode ainda não ter chegado.
  @Property({ type: 'text', nullable: true })
  referenceExternalTransactionId!: string | null;

  // Id interno, preenchido quando a referência é resolvida. Esse é FK.
  @ManyToOne(() => TransactionRecord, {
    mapToPk: true,
    nullable: true,
    fieldName: 'reference_transaction_id',
    deleteRule: 'restrict',
    updateRule: 'restrict',
  })
  referenceTransactionId!: string | null;

  @Property({ type: 'text', nullable: true })
  failureCode!: string | null;

  @Property({ type: 'decimal', precision: 20, scale: 2, nullable: true })
  balanceAfter!: string | null;

  @Property({ type: 'integer', default: 0 })
  attempts!: number;

  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @Property({ type: 'datetime', columnType: 'timestamptz', defaultRaw: 'now()' })
  createdAt!: Date;

  @Property({ type: 'datetime', columnType: 'timestamptz', defaultRaw: 'now()' })
  updatedAt!: Date;
}

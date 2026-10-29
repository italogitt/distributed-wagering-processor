import { Check, Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

/**
 * Modelo de persistência da tabela `wallets`. Não é a entidade de domínio:
 * não tem regras, só espelha o schema. A conversão para `Wallet` (domínio)
 * fica no mapper do repositório.
 *
 * O saldo NÃO é alterado via Unit of Work (ler → calcular → flush): débitos e
 * créditos usam UPDATE atômico condicional. Por isso não usamos `version: true`
 * do MikroORM nem `onUpdate` no `updatedAt`.
 */
@Entity({ tableName: 'wallets' })
@Unique({ name: 'wallets_player_id_currency_uq', properties: ['playerId', 'currency'] })
@Check({ name: 'wallets_player_id_not_blank_chk', expression: 'length(btrim(player_id)) > 0' })
@Check({ name: 'wallets_currency_iso4217_chk', expression: "currency ~ '^[A-Z]{3}$'" })
@Check({ name: 'wallets_balance_non_negative_chk', expression: 'balance >= 0' })
@Check({ name: 'wallets_version_positive_chk', expression: 'version >= 1' })
export class WalletRecord {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property({ type: 'text' })
  playerId!: string;

  @Property({ type: 'text' })
  currency!: string;

  // `decimal` no MikroORM v7 é reidratado como string por padrão; o tipo TS
  // `string` reforça que dinheiro nunca passa por `number`.
  @Property({ type: 'decimal', precision: 20, scale: 2 })
  balance!: string;

  @Property({ type: 'integer', default: 1 })
  version!: number;

  @Property({ type: 'datetime', columnType: 'timestamptz', defaultRaw: 'now()' })
  createdAt!: Date;

  @Property({ type: 'datetime', columnType: 'timestamptz', defaultRaw: 'now()' })
  updatedAt!: Date;
}

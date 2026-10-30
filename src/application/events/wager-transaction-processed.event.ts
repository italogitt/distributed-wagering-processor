import type { Money, MoneyProps } from '../../domain/money';
import type { WagerTransaction, WagerTransactionKind } from '../../domain/wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string | undefined;
  externalTransactionId: string | undefined;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceTransactionId: string | undefined;
  balanceAfter: MoneyProps;
  /** ISO-8601. */
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  readonly aggregateType = 'transaction';

  static from(tx: WagerTransaction, balanceAfter: Money, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        referenceTransactionId: tx.referenceTransactionId,
        balanceAfter: balanceAfter.toJSON(),
        processedAt: (tx.processedAt ?? ctx.occurredAt).toISOString(),
      },
    });
  }
}

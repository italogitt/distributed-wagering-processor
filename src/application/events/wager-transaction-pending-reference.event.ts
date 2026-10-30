import type { MoneyProps } from '../../domain/money';
import type { WagerTransaction, WagerTransactionKind } from '../../domain/wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string | undefined;
  externalTransactionId: string | undefined;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | undefined;
  /** ISO-8601. */
  nextAttemptAt: string;
}

/** A referência ainda não chegou; o worker vai tentar de novo. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  readonly aggregateType = 'transaction';

  static from(tx: WagerTransaction, nextAttemptAt: Date, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
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
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        nextAttemptAt: nextAttemptAt.toISOString(),
      },
    });
  }
}

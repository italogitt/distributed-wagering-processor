import type { FailureCode } from '../../domain/failure-code';
import type { Money, MoneyProps } from '../../domain/money';
import type { WagerTransaction, WagerTransactionKind } from '../../domain/wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string | undefined;
  externalTransactionId: string | undefined;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode | undefined;
  balanceAfter: MoneyProps;
}

/** Transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  readonly aggregateType = 'transaction';

  static from(tx: WagerTransaction, balanceAfter: Money, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
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
        failureCode: tx.failureCode,
        balanceAfter: balanceAfter.toJSON(),
      },
    });
  }
}

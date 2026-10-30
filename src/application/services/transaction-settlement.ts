import { FailureCode } from '../../domain/failure-code';
import type { Money } from '../../domain/money';
import { type WagerTransaction, WagerTransactionStatus } from '../../domain/wager-transaction';
import { LedgerDirection } from '../../domain/wallet-ledger-entry';
import {
  type EventContext,
  type IntegrationEvent,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../events';
import type { IdGenerator } from '../ports/id-generator';
import type { TransactionalRepositories } from '../ports/unit-of-work';
import type { MovementApplied } from '../ports/wallet.repository';

export interface SettlementContext {
  now: Date;
  /** Vai para o correlationId dos eventos. */
  correlationId: string;
}

/**
 * WAITING_REFERENCE: a referência não existe ou ainda está PENDING_REFERENCE;
 * nada foi gravado e a transação não mudou de estado.
 * DECIDED: a transação está PROCESSED ou REJECTED; o saldo e o ledger já foram
 * gravados (se houve movimento) e os eventos estão prontos para a outbox.
 */
export type Settlement =
  | { status: 'WAITING_REFERENCE' }
  | { status: 'DECIDED'; balanceAfter: Money; events: IntegrationEvent<unknown>[] };

/**
 * Regras que decidem uma transação já validada (passos 6 a 8 do caso de uso):
 * referência, reversão ativa, movimento de saldo, `balance_after` e eventos.
 * Usadas por quem recebe a transação (SubmitTransactionUseCase, com INSERT) e
 * pelo worker que reprocessa PENDING_REFERENCE (com UPDATE). Gravar a linha da
 * transação e a outbox fica com quem chama, porque é o que muda entre os dois.
 *
 * Roda dentro da transação SQL de quem chama.
 */
export class TransactionSettlement {
  constructor(private readonly ids: IdGenerator) {}

  async settle(repos: TransactionalRepositories, tx: WagerTransaction, ctx: SettlementContext): Promise<Settlement> {
    // 6. Referência.
    let reference: WagerTransaction | undefined;
    const referenceExternalId = tx.referenceExternalTransactionId;
    if (referenceExternalId !== undefined) {
      const providerId = providerOf(tx);
      // Antes de buscar a referência: uma reversão em PENDING_REFERENCE também
      // ocupa o índice único, e sem esta checagem o retry bateria nele de novo.
      // A própria transação fica de fora (no worker, ela já está gravada).
      if (tx.requiresReference() && (await repos.transactions.hasActiveReversal(providerId, referenceExternalId, tx.id))) {
        tx.reject(FailureCode.AlreadyReversed);
      } else {
        const found = await repos.transactions.findByExternalId(providerId, referenceExternalId);
        if (!found || found.status === WagerTransactionStatus.PendingReference) {
          return { status: 'WAITING_REFERENCE' };
        }
        const code = tx.checkReference(found);
        if (code) {
          tx.reject(code);
        } else {
          reference = found;
        }
      }
    }

    // 7. Movimento de saldo. Não terminal aqui = ainda não rejeitada (PENDING ou PENDING_REFERENCE).
    let movement: MovementApplied | undefined;
    if (!tx.isTerminal()) {
      if (tx.affectsBalance()) {
        const command = {
          walletId: tx.walletId,
          money: tx.money,
          transactionId: tx.id,
          entryId: this.ids.next(),
          at: ctx.now,
        };
        if (tx.ledgerDirectionFor(reference) === LedgerDirection.Debit) {
          const result = await repos.wallets.applyDebit(command);
          if (result.status === 'INSUFFICIENT_BALANCE') {
            tx.reject(tx.insufficientFundsCode());
          } else {
            movement = result;
          }
        } else {
          movement = await repos.wallets.applyCredit(command);
        }
      }
      if (!tx.isTerminal()) {
        tx.markProcessed(reference?.id, ctx.now);
      }
    }

    // 8. balance_after: com movimento, o saldo que o UPDATE devolveu. Sem
    // movimento (qualquer REJECTED e o LOSS), relê agora: o saldo lido antes
    // pode estar velho. Ex.: sem saldo porque outra BET debitou no meio, ou
    // ALREADY_REVERSED porque a reversão vencedora (com o crédito dela)
    // commitou entre a leitura da wallet e a da reversão.
    const balanceAfter = movement ? movement.wallet.balance : await this.currentBalance(repos, tx.walletId);

    const events: IntegrationEvent<unknown>[] = [];
    if (tx.status === WagerTransactionStatus.Processed) {
      events.push(WagerTransactionProcessed.from(tx, balanceAfter, this.eventContext(tx, ctx)));
      if (movement) {
        events.push(WalletBalanceChanged.from(movement.wallet, movement.entry, this.eventContext(tx, ctx)));
      }
    } else {
      events.push(WagerTransactionRejected.from(tx, balanceAfter, this.eventContext(tx, ctx)));
    }
    return { status: 'DECIDED', balanceAfter, events };
  }

  /** Rejeição sem movimento (ex.: TTL da referência estourado): saldo atual + WagerTransactionRejected. */
  async reject(
    repos: TransactionalRepositories,
    tx: WagerTransaction,
    code: FailureCode,
    ctx: SettlementContext,
  ): Promise<Extract<Settlement, { status: 'DECIDED' }>> {
    tx.reject(code);
    const balanceAfter = await this.currentBalance(repos, tx.walletId);
    return {
      status: 'DECIDED',
      balanceAfter,
      events: [WagerTransactionRejected.from(tx, balanceAfter, this.eventContext(tx, ctx))],
    };
  }

  /** causationId = id da transação que gerou o evento. */
  eventContext(tx: WagerTransaction, ctx: SettlementContext): EventContext {
    return { eventId: this.ids.next(), correlationId: ctx.correlationId, causationId: tx.id, occurredAt: ctx.now };
  }

  private async currentBalance(repos: TransactionalRepositories, walletId: string): Promise<Money> {
    const fresh = await repos.wallets.findById(walletId);
    if (!fresh) {
      // A wallet existia quando a transação foi aceita e não há DELETE de wallet: só um bug chega aqui.
      throw new Error(`Wallet ${walletId} sumiu durante a transação`);
    }
    return fresh.balance;
  }
}

/** OPENING não tem provedor nem referência: só transações do provedor chegam aqui. */
function providerOf(tx: WagerTransaction): string {
  if (tx.providerId === undefined) {
    throw new Error(`${tx.kind} ${tx.id} sem providerId não tem referência para resolver`);
  }
  return tx.providerId;
}

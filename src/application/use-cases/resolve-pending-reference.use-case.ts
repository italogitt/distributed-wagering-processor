import { FailureCode } from '../../domain/failure-code';
import type { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { backoffSeconds } from '../backoff';
import type { IdGenerator } from '../ports/id-generator';
import type { UnitOfWork } from '../ports/unit-of-work';
import { TransactionSettlement } from '../services/transaction-settlement';

export interface ResolvePendingReferenceOptions {
  /** Quanto esperar pela referência, contado do createdAt. Depois: REJECTED REFERENCE_NOT_FOUND. */
  ttlMs: number;
  /** Teto do backoff entre tentativas. */
  backoffMaxSeconds: number;
}

interface ResolutionBase {
  transactionId: string;
  kind: WagerTransactionKind;
  correlationId: string;
  /** Tentativas do worker, contando esta. */
  attempts: number;
}

/**
 * decided: a referência apareceu (ou o TTL estourou) e a transação ficou PROCESSED ou REJECTED.
 * rescheduled: referência ainda ausente dentro do TTL; status continua PENDING_REFERENCE.
 */
export type PendingReferenceResolution =
  | (ResolutionBase & { outcome: 'decided'; status: WagerTransactionStatus; failureCode?: FailureCode })
  | (ResolutionBase & { outcome: 'rescheduled'; nextAttemptAt: Date });

/**
 * Worker do PENDING_REFERENCE (seção 7.1). Cada chamada resolve UMA transação,
 * numa transação SQL própria:
 *
 * 1. trava a próxima PENDING_REFERENCE vencida (`FOR UPDATE SKIP LOCKED`);
 * 2. aplica as MESMAS regras da entrada (TransactionSettlement): referência,
 *    reversão ativa, movimento, ledger e eventos;
 * 3. referência ainda ausente (ou também PENDING_REFERENCE): antes do TTL, só
 *    reagenda com backoff; depois do TTL, REJECTED REFERENCE_NOT_FOUND.
 *
 * Eventos: correlationId = o da requisição original (lido do evento
 * WagerTransactionPendingReference na outbox); causationId = id da transação,
 * igual aos eventos da entrada.
 */
export class ResolvePendingReferenceUseCase {
  private readonly settlement: TransactionSettlement;

  constructor(
    private readonly uow: UnitOfWork,
    ids: IdGenerator,
    private readonly options: ResolvePendingReferenceOptions,
  ) {
    this.settlement = new TransactionSettlement(ids);
  }

  /** `null` quando não há nenhuma PENDING_REFERENCE vencida (ou todas estão com outros workers). */
  resolveNext(): Promise<PendingReferenceResolution | null> {
    return this.uow.run(async (repos) => {
      const item = await repos.transactions.lockNextDuePendingReference();
      if (!item) {
        return null;
      }
      const { transaction: tx } = item;
      const attempts = item.attempts + 1;
      const now = new Date();
      // Sem o evento original (não deveria acontecer), o id da transação ainda liga os eventos.
      const correlationId = (await repos.outbox.correlationIdOf(tx.id)) ?? tx.id;
      const ctx = { now, correlationId };
      const base = { transactionId: tx.id, kind: tx.kind, correlationId, attempts };

      let settlement = await this.settlement.settle(repos, tx, ctx);
      if (settlement.status === 'WAITING_REFERENCE') {
        const expired = now.getTime() - tx.createdAt.getTime() >= this.options.ttlMs;
        if (!expired) {
          const nextAttemptAt = new Date(now.getTime() + backoffSeconds(attempts, this.options.backoffMaxSeconds) * 1_000);
          await repos.transactions.reschedulePendingReference(tx.id, attempts, nextAttemptAt);
          return { ...base, outcome: 'rescheduled', nextAttemptAt };
        }
        settlement = await this.settlement.reject(repos, tx, FailureCode.ReferenceNotFound, ctx);
      }

      await repos.transactions.update({ transaction: tx, balanceAfter: settlement.balanceAfter, attempts });
      await repos.outbox.add(settlement.events);
      return { ...base, outcome: 'decided', status: tx.status, failureCode: tx.failureCode };
    });
  }
}

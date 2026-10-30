import { InvalidMoneyError, InvalidWagerTransactionError } from '../../domain/errors';
import { FailureCode } from '../../domain/failure-code';
import { Money, type MoneyProps } from '../../domain/money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import { LedgerDirection } from '../../domain/wallet-ledger-entry';
import {
  IdempotencyConflictError,
  InvalidInputError,
  UniqueViolationError,
  WalletMismatchError,
  WalletNotFoundError,
} from '../errors';
import {
  type EventContext,
  type IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../events';
import { computePayloadHash } from '../payload-hash';
import type { IdGenerator } from '../ports/id-generator';
import type { StoredTransaction } from '../ports/transaction.repository';
import type { TransactionalRepositories, UnitOfWork } from '../ports/unit-of-work';
import type { MovementApplied } from '../ports/wallet.repository';

export interface SubmitTransactionInput {
  idempotencyKey: string;
  /** Header x-request-id ou gerado; vira o correlationId dos eventos. */
  requestId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export interface SubmitTransactionOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  /** Saldo observado na decisão. Não vem em PENDING_REFERENCE. */
  balanceAfter?: MoneyProps;
  idempotentReplay: boolean;
}

/** OPENING é interno: não pode chegar pela API nem pela fila. */
const SUBMITTABLE_KINDS: readonly string[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

/** Primeira nova tentativa de achar a referência ausente (o worker cuida das seguintes). */
const FIRST_REFERENCE_RETRY_MS = 1_000;

interface ParsedInput {
  input: SubmitTransactionInput;
  kind: WagerTransactionKind;
  money: Money;
  payloadHash: string;
}

/**
 * Submete uma transação do provedor (POST /wagering/transactions).
 *
 * Tudo o que lê ou grava no banco roda numa única transação SQL: a transação,
 * o saldo, o lançamento e os eventos da outbox são confirmados juntos ou não
 * são confirmados. A validação de entrada e o hash vêm antes, porque não
 * tocam no banco: um payload inválido nem abre transação.
 */
export class SubmitTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: SubmitTransactionInput): Promise<SubmitTransactionOutput> {
    const parsed = this.parse(input);
    try {
      return await this.uow.run((repos) => this.attempt(repos, parsed));
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) {
        throw error;
      }
      // Corrida: outra requisição gravou a mesma idempotencyKey/externalTransactionId,
      // ou outra reversão da mesma referência (transactions_single_reversal_uq),
      // entre a nossa leitura e o nosso INSERT. A transação SQL anterior já fez
      // rollback (inclusive do débito). Rodamos de novo UMA vez, numa transação
      // nova: agora o passo 3 (idempotência) ou o passo 6 (reversão ativa) acha
      // a linha que venceu e devolve replay, 409 ou ALREADY_REVERSED.
      // É isso que segura "50 envios iguais em paralelo" com um débito só.
      // Se violar de novo, o erro sobe (500): não fazemos loop.
      return this.uow.run((repos) => this.attempt(repos, parsed));
    }
  }

  /** Passos 1 e 2: validação de entrada e hash. Lança InvalidInputError (400). */
  private parse(input: SubmitTransactionInput): ParsedInput {
    if (!SUBMITTABLE_KINDS.includes(input.kind)) {
      throw new InvalidInputError(`kind inválido: ${input.kind}`);
    }
    let money: Money;
    try {
      money = Money.from(input.money);
    } catch (error) {
      if (error instanceof InvalidMoneyError) {
        throw new InvalidInputError(error.message);
      }
      throw error;
    }
    const payloadHash = computePayloadHash({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      amount: input.money.amount,
      currency: input.money.currency,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });
    return { input, kind: input.kind as WagerTransactionKind, money, payloadHash };
  }

  private async attempt(repos: TransactionalRepositories, parsed: ParsedInput): Promise<SubmitTransactionOutput> {
    const { input } = parsed;
    const now = new Date();

    // 3. Idempotência.
    const existing = await repos.transactions.findByIdempotencyKey(input.providerId, input.idempotencyKey);
    if (existing) {
      if (!existing.transaction.matchesPayload(parsed.payloadHash)) {
        throw new IdempotencyConflictError(`idempotencyKey ${input.idempotencyKey} já usada com outro payload`);
      }
      return this.replay(existing);
    }
    const sameExternalId = await repos.transactions.findByExternalId(input.providerId, input.externalTransactionId);
    if (sameExternalId) {
      throw new IdempotencyConflictError(
        `externalTransactionId ${input.externalTransactionId} já usado com outra idempotencyKey`,
      );
    }

    // 4. Wallet. Nada é gravado se falhar (I8).
    const wallet = await repos.wallets.findById(input.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(input.walletId);
    }
    if (wallet.playerId !== input.playerId || wallet.currency !== parsed.money.currency) {
      throw new WalletMismatchError(`Wallet ${wallet.id} não é do player ${input.playerId} em ${parsed.money.currency}`);
    }

    // 5. Transação em memória (PENDING).
    const tx = this.createTransaction(parsed, now);

    // 6. Referência.
    let reference: WagerTransaction | undefined;
    const referenceExternalId = tx.referenceExternalTransactionId;
    if (referenceExternalId !== undefined) {
      // Antes de buscar a referência: uma reversão em PENDING_REFERENCE também
      // ocupa o índice único, e sem esta checagem o retry bateria nele de novo.
      if (tx.requiresReference() && (await repos.transactions.hasActiveReversal(input.providerId, referenceExternalId))) {
        tx.reject(FailureCode.AlreadyReversed);
      } else {
        const found = await repos.transactions.findByExternalId(input.providerId, referenceExternalId);
        if (!found || found.status === WagerTransactionStatus.PendingReference) {
          return this.waitForReference(repos, tx, input, now);
        }
        const code = tx.checkReference(found);
        if (code) {
          tx.reject(code);
        } else {
          reference = found;
        }
      }
    }

    // 7. Movimento de saldo.
    let movement: MovementApplied | undefined;
    let balanceAfter = wallet.balance;
    if (tx.status === WagerTransactionStatus.Pending) {
      if (tx.affectsBalance()) {
        const command = {
          walletId: wallet.id,
          money: tx.money,
          transactionId: tx.id,
          entryId: this.ids.next(),
          at: now,
        };
        if (tx.ledgerDirectionFor(reference) === LedgerDirection.Debit) {
          const result = await repos.wallets.applyDebit(command);
          if (result.status === 'INSUFFICIENT_BALANCE') {
            tx.reject(tx.insufficientFundsCode());
            // Relê: o saldo pode ter mudado desde o passo 4 (foi o que nos deixou sem saldo).
            balanceAfter = await this.currentBalance(repos, wallet);
          } else {
            movement = result;
          }
        } else {
          movement = await repos.wallets.applyCredit(command);
        }
      }
      if (tx.status === WagerTransactionStatus.Pending) {
        tx.markProcessed(reference?.id, now);
      }
    }

    // 8. balance_after: depois do movimento; em REJECTED e LOSS, o saldo atual.
    if (movement) {
      balanceAfter = movement.wallet.balance;
    }

    // 9. Estado final + eventos, na mesma transação SQL.
    await repos.transactions.insert({ transaction: tx, balanceAfter });
    const events: IntegrationEvent<unknown>[] = [];
    if (tx.status === WagerTransactionStatus.Processed) {
      events.push(WagerTransactionProcessed.from(tx, balanceAfter, this.eventContext(input, tx, now)));
      if (movement) {
        events.push(WalletBalanceChanged.from(movement.wallet, movement.entry, this.eventContext(input, tx, now)));
      }
    } else {
      events.push(WagerTransactionRejected.from(tx, balanceAfter, this.eventContext(input, tx, now)));
    }
    await repos.outbox.add(events);

    return {
      transactionId: tx.id,
      status: tx.status,
      failureCode: tx.failureCode,
      balanceAfter: balanceAfter.toJSON(),
      idempotentReplay: false,
    };
  }

  /** Erros de regra do create (ex.: LOSS com valor, BET com referência) são payload inválido: 400. */
  private createTransaction(parsed: ParsedInput, now: Date): WagerTransaction {
    const { input } = parsed;
    try {
      return WagerTransaction.create({
        id: this.ids.next(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: parsed.payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: parsed.kind,
        money: parsed.money,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
        createdAt: now,
      });
    } catch (error) {
      if (error instanceof InvalidWagerTransactionError) {
        throw new InvalidInputError(error.message);
      }
      throw error;
    }
  }

  /** Referência ausente: grava PENDING_REFERENCE para o worker tentar de novo (202). */
  private async waitForReference(
    repos: TransactionalRepositories,
    tx: WagerTransaction,
    input: SubmitTransactionInput,
    now: Date,
  ): Promise<SubmitTransactionOutput> {
    tx.markPendingReference();
    const nextAttemptAt = new Date(now.getTime() + FIRST_REFERENCE_RETRY_MS);
    await repos.transactions.insert({ transaction: tx, nextAttemptAt });
    await repos.outbox.add([
      WagerTransactionPendingReference.from(tx, nextAttemptAt, this.eventContext(input, tx, now)),
    ]);
    return { transactionId: tx.id, status: tx.status, idempotentReplay: false };
  }

  /** Devolve o resultado original, sem mudar nada (regra 7). */
  private replay(stored: StoredTransaction): SubmitTransactionOutput {
    const { transaction } = stored;
    return {
      transactionId: transaction.id,
      status: transaction.status,
      failureCode: transaction.failureCode,
      balanceAfter: stored.balanceAfter?.toJSON(),
      idempotentReplay: true,
    };
  }

  private async currentBalance(repos: TransactionalRepositories, wallet: Wallet): Promise<Money> {
    const fresh = await repos.wallets.findById(wallet.id);
    if (!fresh) {
      // A wallet existia no passo 4 e não há DELETE de wallet: só um bug chega aqui.
      throw new Error(`Wallet ${wallet.id} sumiu durante a transação`);
    }
    return fresh.balance;
  }

  private eventContext(input: SubmitTransactionInput, tx: WagerTransaction, now: Date): EventContext {
    return { eventId: this.ids.next(), correlationId: input.requestId, causationId: tx.id, occurredAt: now };
  }
}

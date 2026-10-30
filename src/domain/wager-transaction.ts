import { InvalidTransactionStateError, InvalidWagerTransactionError } from './errors';
import { FailureCode } from './failure-code';
import type { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Não vem da API nem da fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. */
  Pending = 'PENDING',
  /** Aguardando a transação referenciada. */
  PendingReference = 'PENDING_REFERENCE',
  /** Aplicada (terminal). */
  Processed = 'PROCESSED',
  /** Violação de regra de negócio (terminal). */
  Rejected = 'REJECTED',
  /** Erro permanente de infraestrutura (terminal, auditável). */
  Failed = 'FAILED',
}

/**
 * Transições válidas. Qualquer outra lança InvalidTransactionStateError.
 * PENDING_REFERENCE → PENDING_REFERENCE não existe: o worker só reagenda a
 * próxima tentativa, sem chamar o domínio.
 */
const ALLOWED_TRANSITIONS: Record<WagerTransactionStatus, readonly WagerTransactionStatus[]> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

/** Que kind cada operação pode referenciar (regra 3; WIN só a BET, ver I5). */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
};

export interface CreateWagerTransactionProps {
  id: string;
  /** Campos de provedor: obrigatórios em todo kind, exceto OPENING, que não tem nenhum. */
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  /** Hash do payload, calculado fora do domínio. */
  payloadHash?: string;
  roundId?: string;
  gameId?: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Id no provedor, não o id interno. */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

/**
 * Uma operação do provedor (ou a abertura interna da wallet) e o seu ciclo de
 * vida. Não mexe em saldo: diz se afeta o saldo, em que direção e se a
 * referência é válida. Quem aplica o movimento é a Wallet, via repositório.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string | undefined,
    public readonly externalTransactionId: string | undefined,
    public readonly idempotencyKey: string | undefined,
    public readonly payloadHash: string | undefined,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string | undefined,
    public readonly gameId: string | undefined,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  /** Nasce em PENDING. As regras espelham os CHECKs da tabela `transactions`. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertAmount(props);
    WagerTransaction.assertReference(props);
    WagerTransaction.assertProviderFields(props);

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  // ---- transições

  /**
   * `referenceTransactionId` (id interno) vem se, e somente se, a transação
   * tem `referenceExternalTransactionId`. Assim um WIN sem referência não
   * ganha uma por engano, e um REFUND não fica sem a sua.
   */
  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertCanMoveTo(WagerTransactionStatus.Processed);
    const hasReference = this.referenceExternalTransactionId !== undefined;
    if (hasReference !== (referenceTransactionId !== undefined)) {
      throw new InvalidTransactionStateError(
        hasReference
          ? `${this.kind} ${this.id} tem referência: markProcessed exige referenceTransactionId`
          : `${this.kind} ${this.id} não tem referência: markProcessed não aceita referenceTransactionId`,
      );
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  /** Só faz sentido esperar por uma referência se a transação tem uma. */
  markPendingReference(): void {
    this.assertCanMoveTo(WagerTransactionStatus.PendingReference);
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(`${this.kind} ${this.id} não tem referência para esperar`);
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertCanMoveTo(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertCanMoveTo(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  // ---- consultas

  isTerminal(): boolean {
    return ALLOWED_TRANSITIONS[this._status].length === 0;
  }

  /** Só o LOSS não mexe no saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** O ROLLBACK precisa da referência: ele é o inverso do movimento dela. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (reference === undefined) {
          throw new InvalidTransactionStateError(`ROLLBACK ${this.id}: direção exige a referência`);
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError(`LOSS ${this.id} não gera lançamento`);
    }
  }

  /** Códigos distintos para aposta sem saldo e reversão sem saldo (regra 9). */
  insufficientFundsCode(): FailureCode {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return FailureCode.InsufficientFunds;
      case WagerTransactionKind.Rollback:
        return FailureCode.ReversalInsufficientFunds;
      default:
        throw new InvalidTransactionStateError(`${this.kind} ${this.id} não debita: não fica sem saldo`);
    }
  }

  /**
   * Valida a referência já encontrada. Devolve o código de rejeição, ou
   * `undefined` se ela serve. Não muda estado.
   *
   * "Já revertida" (ALREADY_REVERSED) não é checada aqui: depende de outras
   * transações, e o banco garante com um índice único.
   */
  checkReference(reference: WagerTransaction): FailureCode | undefined {
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(`${this.kind} ${this.id} não tem referência para validar`);
    }
    if (reference.status === WagerTransactionStatus.PendingReference) {
      // O caso de uso deve esperar a referência ser resolvida antes de chamar.
      throw new InvalidTransactionStateError(
        `Referência ${reference.id} ainda está PENDING_REFERENCE`,
      );
    }
    // PENDING, REJECTED e FAILED: a referência não foi aplicada.
    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.InvalidReference;
    }

    const allowedKinds = ALLOWED_REFERENCE_KINDS[this.kind] ?? [];
    if (!allowedKinds.includes(reference.kind)) {
      return FailureCode.InvalidReference;
    }

    const sameOwner =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.money.currency === this.money.currency &&
      reference.roundId === this.roundId;
    if (!sameOwner) {
      return FailureCode.InvalidReference;
    }

    if (this.requiresReference() && !reference.money.equals(this.money)) {
      return FailureCode.AmountMismatch;
    }
    return undefined;
  }

  // ---- validações internas

  private assertCanMoveTo(next: WagerTransactionStatus): void {
    if (!ALLOWED_TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(
        `Transição inválida em ${this.id}: ${this._status} → ${next}`,
      );
    }
  }

  private static assertAmount(props: CreateWagerTransactionProps): void {
    if (props.kind === WagerTransactionKind.Loss) {
      if (!props.money.isZero()) {
        throw new InvalidWagerTransactionError(`LOSS exige valor 0, recebeu ${props.money}`);
      }
    } else if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(`${props.kind} exige valor > 0, recebeu ${props.money}`);
    }
  }

  /** Obrigatória em REFUND/ROLLBACK, opcional em WIN, proibida no resto. */
  private static assertReference(props: CreateWagerTransactionProps): void {
    const hasReference = props.referenceExternalTransactionId !== undefined;
    switch (props.kind) {
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Rollback:
        if (!hasReference) {
          throw new InvalidWagerTransactionError(`${props.kind} exige referenceExternalTransactionId`);
        }
        return;
      case WagerTransactionKind.Win:
        return;
      case WagerTransactionKind.Bet:
      case WagerTransactionKind.Loss:
      case WagerTransactionKind.Opening:
        if (hasReference) {
          throw new InvalidWagerTransactionError(`${props.kind} não aceita referenceExternalTransactionId`);
        }
        return;
    }
  }

  /** OPENING não tem nenhum campo de provedor; os outros kinds têm todos. */
  private static assertProviderFields(props: CreateWagerTransactionProps): void {
    const fields = {
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      roundId: props.roundId,
      gameId: props.gameId,
    };
    const entries = Object.entries(fields);
    if (props.kind === WagerTransactionKind.Opening) {
      const present = entries.filter(([, value]) => value !== undefined).map(([name]) => name);
      if (present.length > 0) {
        throw new InvalidWagerTransactionError(`OPENING não tem dados de provedor: ${present.join(', ')}`);
      }
      return;
    }
    const missing = entries.filter(([, value]) => value === undefined).map(([name]) => name);
    if (missing.length > 0) {
      throw new InvalidWagerTransactionError(`${props.kind} exige ${missing.join(', ')}`);
    }
  }
}

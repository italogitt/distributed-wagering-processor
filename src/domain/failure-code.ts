/** Motivos de rejeição/falha, estáveis e legíveis por máquina (seção 7.2). */
export enum FailureCode {
  /** BET sem saldo. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK que deixaria o saldo negativo (regra 9). */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Estourou o limite de espera pela referência. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência existe, mas é de outro player/wallet/moeda/rodada, de kind incompatível ou não PROCESSED. */
  InvalidReference = 'INVALID_REFERENCE',
  /** Referência já revertida (regra 4). */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** Valor diferente do da referência (regra 5). */
  AmountMismatch = 'AMOUNT_MISMATCH',
}

import { DomainError } from './domain.error';

/** Lançamento do ledger com dados inconsistentes (valor, saldos ou aritmética). */
export class InvalidLedgerEntryError extends DomainError {}

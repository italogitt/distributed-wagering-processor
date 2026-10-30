import { ApplicationError } from './application.error';

/** Já existe wallet para o mesmo playerId + currency (wallets_player_id_currency_uq). HTTP 409. */
export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}

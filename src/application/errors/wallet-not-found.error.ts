import { ApplicationError } from './application.error';

/** HTTP 404. Nada é gravado (I8). */
export class WalletNotFoundError extends ApplicationError {
  constructor(public readonly walletId: string) {
    super(`Wallet ${walletId} não existe`);
  }
}

import { ApplicationError } from './application.error';

/** A wallet existe, mas é de outro player ou de outra moeda. HTTP 422. Nada é gravado (I8). */
export class WalletMismatchError extends ApplicationError {}

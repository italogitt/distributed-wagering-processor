import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import {
  ApplicationError,
  IdempotencyConflictError,
  InvalidInputError,
  WalletMismatchError,
  WalletNotFoundError,
} from '../../application/errors';
import type { HttpResponse } from './http-response';

export interface HttpError {
  status: number;
  /** Código estável, para o provedor decidir sem ler a mensagem. */
  code: string;
}

export function httpErrorFor(error: ApplicationError): HttpError {
  if (error instanceof InvalidInputError) return { status: 400, code: 'INVALID_INPUT' };
  if (error instanceof WalletNotFoundError) return { status: 404, code: 'WALLET_NOT_FOUND' };
  if (error instanceof IdempotencyConflictError) return { status: 409, code: error.code };
  if (error instanceof WalletMismatchError) return { status: 422, code: 'WALLET_MISMATCH' };
  // Um ApplicationError novo sem mapeamento é bug nosso, não do cliente.
  return { status: 500, code: 'INTERNAL_ERROR' };
}

/**
 * Traduz os erros do caso de uso para HTTP. Erros que não são
 * ApplicationError (ex.: banco fora do ar) seguem para o handler padrão do Nest (500).
 */
@Catch(ApplicationError)
export class ApplicationErrorFilter implements ExceptionFilter<ApplicationError> {
  catch(error: ApplicationError, host: ArgumentsHost): void {
    const { status, code } = httpErrorFor(error);
    host.switchToHttp().getResponse<HttpResponse>().status(status).json({ error: code, message: error.message });
  }
}

import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import {
  ApplicationError,
  IdempotencyConflictError,
  InvalidInputError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletMismatchError,
  WalletNotFoundError,
} from '../../application/errors';
import type { HttpResponse } from './http-response';

export interface HttpError {
  status: number;
  /** Código estável, para o provedor decidir sem ler a mensagem. */
  code: string;
}

export function httpErrorFor(error: ApplicationError | TransientInfrastructureError): HttpError {
  // Banco indisponível, timeout ou deadlock: nada foi gravado, o provedor reenvia com a mesma key.
  if (error instanceof TransientInfrastructureError) return { status: 503, code: 'SERVICE_UNAVAILABLE' };
  if (error instanceof InvalidInputError) return { status: 400, code: 'INVALID_INPUT' };
  if (error instanceof WalletNotFoundError) return { status: 404, code: 'WALLET_NOT_FOUND' };
  if (error instanceof TransactionNotFoundError) return { status: 404, code: 'TRANSACTION_NOT_FOUND' };
  if (error instanceof IdempotencyConflictError) return { status: 409, code: error.code };
  if (error instanceof WalletAlreadyExistsError) return { status: 409, code: error.code };
  if (error instanceof WalletMismatchError) return { status: 422, code: 'WALLET_MISMATCH' };
  // Um ApplicationError novo sem mapeamento é bug nosso, não do cliente.
  return { status: 500, code: 'INTERNAL_ERROR' };
}

/**
 * Traduz os erros do caso de uso para HTTP. Falha transitória vira 503; os
 * demais erros (bugs) seguem para o handler padrão do Nest (500).
 */
@Catch(ApplicationError, TransientInfrastructureError)
export class ApplicationErrorFilter implements ExceptionFilter<ApplicationError | TransientInfrastructureError> {
  catch(error: ApplicationError | TransientInfrastructureError, host: ArgumentsHost): void {
    const { status, code } = httpErrorFor(error);
    host.switchToHttp().getResponse<HttpResponse>().status(status).json({ error: code, message: error.message });
  }
}

import { ApplicationError } from './application.error';

/**
 * A mensagem já está na inbox: foi processada e commitada antes. Quem
 * consome a fila dá ack sem efeito. Nunca chega à API HTTP (que não usa inbox).
 */
export class DuplicateMessageError extends ApplicationError {
  constructor(public readonly messageId: string) {
    super(`Mensagem ${messageId} já processada`);
  }
}

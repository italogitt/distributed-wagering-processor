import { randomUUID } from 'node:crypto';
import { Body, Controller, Headers, HttpCode, Inject, Post, Res } from '@nestjs/common';
import { SubmitTransactionUseCase } from '../../application/use-cases/submit-transaction.use-case';
import type { HttpResponse } from './http-response';
import {
  httpStatusFor,
  parseSubmitTransactionRequest,
  type SubmitTransactionResponse,
  toSubmitTransactionResponse,
} from './submit-transaction.http';

@Controller('wagering')
export class WageringController {
  // @Inject explícito: não depende do metadata de tipos emitido pelo compilador.
  constructor(@Inject(SubmitTransactionUseCase) private readonly submitTransaction: SubmitTransactionUseCase) {}

  @Post('transactions')
  @HttpCode(200)
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
    @Body() body: unknown,
    // passthrough: só trocamos o status; o Nest continua serializando o retorno.
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<SubmitTransactionResponse> {
    const input = parseSubmitTransactionRequest({ idempotencyKey, requestId: requestId ?? randomUUID() }, body);
    const output = await this.submitTransaction.execute(input);
    response.status(httpStatusFor(output));
    return toSubmitTransactionResponse(output);
  }
}

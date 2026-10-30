import { randomUUID } from 'node:crypto';
import { Body, Controller, Headers, HttpCode, Inject, Post, Res } from '@nestjs/common';
import { SubmitTransactionUseCase } from '../../application/use-cases/submit-transaction.use-case';
import type { LogFields, Logger } from '../../infrastructure/logging/logger';
import type { Metrics } from '../../infrastructure/metrics/metrics';
import type { HttpResponse } from './http-response';
import { METRICS } from './metrics.controller';
import {
  httpStatusFor,
  parseSubmitTransactionRequest,
  type SubmitTransactionResponse,
  toSubmitTransactionResponse,
} from './submit-transaction.http';

export const WAGERING_LOGGER = Symbol('WAGERING_LOGGER');

@Controller('wagering')
export class WageringController {
  // @Inject explícito: não depende do metadata de tipos emitido pelo compilador.
  constructor(
    @Inject(SubmitTransactionUseCase) private readonly submitTransaction: SubmitTransactionUseCase,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(WAGERING_LOGGER) private readonly logger: Logger,
  ) {}

  @Post('transactions')
  @HttpCode(200)
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
    @Body() body: unknown,
    // passthrough: só trocamos o status; o Nest continua serializando o retorno.
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<SubmitTransactionResponse> {
    const startedAt = performance.now();
    const correlationId = requestId ?? randomUUID();
    // Só ids do corpo (nunca o valor): o corpo pode ser inválido, por isso a leitura defensiva.
    const fields: LogFields = { correlationId, ...idsOf(body) };
    try {
      const input = parseSubmitTransactionRequest({ idempotencyKey, requestId: correlationId }, body);
      const output = await this.submitTransaction.execute(input);
      this.metrics.transactionDecided({ source: 'http', kind: input.kind, ...output });
      this.metrics.observeProcessing('http', (performance.now() - startedAt) / 1_000);
      this.logger.info('http transaction handled', {
        ...fields,
        transactionId: output.transactionId,
        status: output.status,
        failureCode: output.failureCode,
        idempotentReplay: output.idempotentReplay,
        durationMs: Math.round(performance.now() - startedAt),
      });
      response.status(httpStatusFor(output));
      return toSubmitTransactionResponse(output);
    } catch (error) {
      // O filtro responde; aqui só o nome do erro (a mensagem pode citar o valor).
      this.logger.warn('http transaction failed', {
        ...fields,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        durationMs: Math.round(performance.now() - startedAt),
      });
      throw error;
    }
  }
}

function idsOf(body: unknown): LogFields {
  if (typeof body !== 'object' || body === null) return {};
  const { walletId, providerId, externalTransactionId, kind } = body as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  return {
    walletId: text(walletId),
    providerId: text(providerId),
    externalTransactionId: text(externalTransactionId),
    kind: text(kind),
  };
}

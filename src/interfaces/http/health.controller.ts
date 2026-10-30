import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import type { HttpResponse } from './http-response';

export const SQS_CLIENT = Symbol('SQS_CLIENT');
export const HEALTH_DEPENDENCIES = Symbol('HEALTH_DEPENDENCIES');

/** O que o readiness consulta. Montado no AppModule. */
export interface HealthDependencies {
  em: EntityManager;
  sqs: SQSClient;
  queueUrl: string;
}

type CheckStatus = 'up' | 'down';

/** Cada dependência tem até isso para responder; senão conta como fora. */
const CHECK_TIMEOUT_MS = 2_000;

@Controller('health')
export class HealthController {
  constructor(@Inject(HEALTH_DEPENDENCIES) private readonly deps: HealthDependencies) {}

  /** Processo vivo: não consulta nada, para o orquestrador não reiniciar a app por causa do banco. */
  @Get('live')
  @HttpCode(200)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Pronto para receber tráfego: Postgres E SQS respondem. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: HttpResponse) {
    const [postgres, sqs] = await Promise.all([
      check(() => this.deps.em.fork().execute('select 1')),
      check((signal) =>
        this.deps.sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: this.deps.queueUrl, AttributeNames: ['QueueArn'] }),
          { abortSignal: signal },
        ),
      ),
    ]);
    const ok = postgres === 'up' && sqs === 'up';
    response.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }
}

async function check(probe: (signal: AbortSignal) => Promise<unknown>): Promise<CheckStatus> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CheckStatus>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('down');
    }, CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([probe(controller.signal).then((): CheckStatus => 'up'), timeout]);
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

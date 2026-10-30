import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { errorFields, type Logger } from '../../infrastructure/logging/logger';
import { settlesWithin, sleep } from './timing';

export interface PollingWorkerOptions {
  /** Liga sozinho no bootstrap da app. Desligado, só roda se alguém chamar start(). */
  enabled: boolean;
  /** Espera entre ciclos quando não houve trabalho (ou depois de um erro). */
  idleDelayMs: number;
  /** No SIGTERM, quanto esperar o ciclo atual terminar. */
  shutdownTimeoutMs: number;
}

/**
 * Loop de um worker agendado dentro da app Nest: roda `tick()` em sequência;
 * quando não há trabalho, espera `idleDelayMs`. Um erro no ciclo é logado e o
 * loop segue depois da espera (o próximo ciclo tenta de novo).
 *
 * SIGTERM (beforeApplicationShutdown, antes do MikroORM fechar): não começa
 * outro ciclo e espera o atual terminar, até `shutdownTimeoutMs`.
 */
export abstract class PollingWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private loop?: Promise<void>;
  private abort = new AbortController();

  protected constructor(
    protected readonly name: string,
    protected readonly pollingOptions: PollingWorkerOptions,
    protected readonly logger: Logger,
  ) {}

  /** Um ciclo. Devolve quantos itens tratou: 0 faz o loop esperar `idleDelayMs`. */
  protected abstract tick(): Promise<number>;

  onApplicationBootstrap(): void {
    if (this.pollingOptions.enabled) {
      this.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.run();
    this.logger.info(`${this.name} started`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    const drained = await settlesWithin(this.loop, this.pollingOptions.shutdownTimeoutMs);
    this.logger.info(`${this.name} stopped`, { drained });
  }

  private async run(): Promise<void> {
    while (this.running) {
      let handled = 0;
      try {
        handled = await this.tick();
      } catch (error) {
        this.logger.error(`${this.name} cycle failed`, errorFields(error));
      }
      if (handled === 0) {
        await sleep(this.pollingOptions.idleDelayMs, this.abort.signal);
      }
    }
  }
}

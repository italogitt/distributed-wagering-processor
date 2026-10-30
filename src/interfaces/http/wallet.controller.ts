import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { WalletView } from '../../application/ports/wallet-read-model';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case';
import {
  ReconcileWalletUseCase,
  type ReconciliationResult,
} from '../../application/use-cases/reconcile-wallet.use-case';
import { type LedgerPage, WalletQueries } from '../../application/use-cases/wallet-queries';
import type { Logger } from '../../infrastructure/logging/logger';
import type { Metrics } from '../../infrastructure/metrics/metrics';
import { AuthGuard } from './auth.guard';
import { METRICS } from './metrics.controller';
import { parseCreateWalletRequest, parseLimit } from './wallet.http';

export const WALLET_LOGGER = Symbol('WALLET_LOGGER');

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ReconcileWalletUseCase) private readonly reconcileWallet: ReconcileWalletUseCase,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(WALLET_LOGGER) private readonly logger: Logger,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Headers('x-request-id') requestId: string | undefined, @Body() body: unknown): Promise<WalletView> {
    return this.createWallet.execute(parseCreateWalletRequest(requestId ?? randomUUID(), body));
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.queries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<LedgerPage> {
    return this.queries.getLedger({ walletId, cursor, limit: parseLimit(limit) });
  }

  /** 200: só lê e compara; não cria nem corrige nada. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(
    @Headers('x-request-id') requestId: string | undefined,
    @Param('walletId') walletId: string,
  ): Promise<ReconciliationResult> {
    const result = await this.reconcileWallet.execute(walletId);
    if (!result.consistent) {
      this.metrics.reconciliationMismatch();
      // Sem valores no log (seção 12): a diferença vai na resposta.
      this.logger.warn('wallet reconciliation mismatch', {
        correlationId: requestId ?? randomUUID(),
        walletId,
        checkedEntries: result.checkedEntries,
      });
    }
    return result;
  }
}

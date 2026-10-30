import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import type { TransactionView } from '../../application/ports/wallet-read-model';
import { WalletQueries } from '../../application/use-cases/wallet-queries';
import { AuthGuard } from './auth.guard';

/** Consultas de transação (seção 9). Separado do WageringController porque uma das rotas fica sob /providers. */
@Controller()
@UseGuards(AuthGuard)
export class TransactionQueryController {
  constructor(@Inject(WalletQueries) private readonly queries: WalletQueries) {}

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId') transactionId: string): Promise<TransactionView> {
    return this.queries.getTransaction(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}

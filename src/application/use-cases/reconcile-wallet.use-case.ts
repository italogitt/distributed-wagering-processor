import { Money, type MoneyProps } from '../../domain/money';
import { WalletNotFoundError } from '../errors';
import type { WalletReadModel } from '../ports/wallet-read-model';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  /** storedBalance - calculatedBalance. */
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * POST /wallets/:walletId/reconciliation (seção 9): compara o saldo guardado
 * com créditos - débitos do ledger, lidos no mesmo snapshot. Não corrige nada:
 * quem chama sinaliza a divergência (log + métrica).
 */
export class ReconcileWalletUseCase {
  constructor(private readonly readModel: WalletReadModel) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const snapshot = await this.readModel.reconciliationSnapshot(walletId);
    if (!snapshot) throw new WalletNotFoundError(walletId);

    const stored = signedMoney(snapshot.storedBalance);
    const calculated = signedMoney(snapshot.ledgerSum);
    const difference = stored.subtract(calculated);
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: snapshot.checkedEntries,
    };
  }
}

/** A soma de um ledger corrompido pode ser negativa; Money.from só aceita valor sem sinal. */
function signedMoney({ amount, currency }: MoneyProps): Money {
  return amount.startsWith('-') ? Money.from({ amount: amount.slice(1), currency }).negate() : Money.from({ amount, currency });
}

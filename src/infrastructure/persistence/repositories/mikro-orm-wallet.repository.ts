import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  ApplyCreditResult,
  ApplyDebitResult,
  ApplyMovementCommand,
  MovementApplied,
  WalletRepository,
} from '../../../application/ports/wallet.repository';
import { Wallet } from '../../../domain/wallet';
import { LedgerEntryRecord } from '../entities/ledger-entry.record';
import { WalletRecord } from '../entities/wallet.record';
import { toWallet } from '../mappers/wallet.mapper';

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// D10: a condição `balance >= valor` fica no próprio UPDATE. Duas requisições
// concorrentes na mesma wallet se enfileiram no lock da linha, e a segunda
// reavalia o WHERE com o saldo já debitado pela primeira.
const DEBIT_SQL =
  'update "wallets" set "balance" = "balance" - ?, "version" = "version" + 1, "updated_at" = ?' +
  ' where "id" = ? and "balance" >= ? returning *';

const CREDIT_SQL =
  'update "wallets" set "balance" = "balance" + ?, "version" = "version" + 1, "updated_at" = ?' +
  ' where "id" = ? returning *';

type Direction = 'DEBIT' | 'CREDIT';

/** Implementação da porta do saldo. O contrato (UPDATE condicional + lançamento) está em `WalletRepository`. */
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    // Um id fora do formato UUID faria o Postgres lançar erro de cast (500).
    // Para quem chamou, é só uma wallet que não existe.
    if (!UUID_FORMAT.test(id)) {
      return null;
    }
    // Sem identity map: o saldo precisa vir do banco a cada leitura, não de um cache da requisição.
    const record = await this.em.findOne(WalletRecord, { id }, { disableIdentityMap: true });
    return record ? toWallet(record) : null;
  }

  async applyDebit(command: ApplyMovementCommand): Promise<ApplyDebitResult> {
    const applied = await this.move(command, 'DEBIT');
    return applied ?? { status: 'INSUFFICIENT_BALANCE' };
  }

  async applyCredit(command: ApplyMovementCommand): Promise<ApplyCreditResult> {
    const applied = await this.move(command, 'CREDIT');
    if (!applied) {
      // O caso de uso já leu a wallet no passo 4 e não existe DELETE de wallet.
      throw new Error(`Wallet ${command.walletId} não encontrada no crédito`);
    }
    return applied;
  }

  /** Devolve `null` quando o UPDATE não afeta nenhuma linha. */
  private async move(command: ApplyMovementCommand, direction: Direction): Promise<MovementApplied | null> {
    const amount = command.money.toJSON().amount;
    const rows =
      direction === 'DEBIT'
        ? await this.em.execute(DEBIT_SQL, [amount, command.at, command.walletId, amount])
        : await this.em.execute(CREDIT_SQL, [amount, command.at, command.walletId]);
    const [row] = rows;
    if (!row) {
      return null;
    }
    const after = toWallet(this.em.map(WalletRecord, row, { disableIdentityMap: true }));

    // Reidrata o estado DE ANTES e refaz a conta no domínio: é a Wallet que
    // produz o lançamento validado. O updatedAt de antes não importa, porque
    // debit/credit o sobrescrevem com `at`.
    const wallet = Wallet.rehydrate({
      id: after.id,
      playerId: after.playerId,
      currency: after.currency,
      balance: direction === 'DEBIT' ? after.balance.add(command.money) : after.balance.subtract(command.money),
      version: after.version - 1,
      createdAt: after.createdAt,
      updatedAt: after.updatedAt,
    });
    const props = { entryId: command.entryId, money: command.money, transactionId: command.transactionId, at: command.at };
    const entry = direction === 'DEBIT' ? wallet.debit(props) : wallet.credit(props);

    await this.em.insert(LedgerEntryRecord, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      createdAt: entry.createdAt,
    });

    return { status: 'APPLIED', wallet, entry };
  }
}

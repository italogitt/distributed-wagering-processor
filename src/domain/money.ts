import { isIso4217Format, isSupportedCurrency, SUPPORTED_CURRENCIES } from './currency';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Formato de contrato (API, fila, banco). `amount` é string decimal com 2 casas. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

// Inteiro sem zero à esquerda ("0" ou começando de 1-9) + ponto + exatamente 2 casas.
// Sem flag `m`, o `$` do JS só casa no fim real da string (não antes de um "\n").
const AMOUNT_FORMAT = /^(0|[1-9]\d*)\.\d{2}$/;

// A coluna é numeric(20,2): 20 dígitos no total, 2 depois da vírgula.
const MAX_INTEGER_DIGITS = 18;

const CENTS_PER_UNIT = 100n;

/**
 * Value object de dinheiro. Imutável: toda operação devolve uma nova instância.
 *
 * Por dentro o valor é `bigint` em centavos (D4): a escala é fixa em 2 casas,
 * então todo valor é um inteiro de centavos e a conta é exata. A string
 * decimal só existe nas bordas (`from` e `toJSON`).
 *
 * `from()` rejeita negativos, mas `subtract()` e `negate()` podem gerar
 * negativo: é assim que a `Wallet` detecta saldo insuficiente (D20).
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    Money.assertValidCurrency(props.currency);
    return new Money(Money.parseAmount(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertValidCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    // bigint não tem -0, então negate() de zero continua sendo zero.
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  /** Moedas diferentes não são erro aqui: "10 BRL ≠ 10 USD" é uma resposta válida. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  /** Chamado pelo `JSON.stringify`, então o `bigint` nunca vaza do objeto. */
  toJSON(): MoneyProps {
    return { amount: Money.formatCents(this.cents), currency: this.currency };
  }

  toString(): string {
    return `${Money.formatCents(this.cents)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertValidCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string') {
      throw new InvalidMoneyError('Moeda deve ser uma string');
    }
    if (!isIso4217Format(currency)) {
      throw new InvalidMoneyError(
        `Moeda "${currency}" fora do formato ISO-4217 (3 letras maiúsculas)`,
      );
    }
    if (!isSupportedCurrency(currency)) {
      throw new InvalidMoneyError(
        `Moeda "${currency}" não aceita. Aceitas: ${SUPPORTED_CURRENCIES.join(', ')}`,
      );
    }
  }

  /** "25.00" → 2500n. Converte direto de string para bigint, sem passar por number. */
  private static parseAmount(amount: unknown): bigint {
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('Valor deve ser uma string decimal, ex.: "25.00"');
    }
    if (!AMOUNT_FORMAT.test(amount)) {
      throw new InvalidMoneyError(
        `Valor "${amount}" inválido: use dígitos, ponto e exatamente 2 casas decimais, ` +
          'sem sinal e sem zeros à esquerda (ex.: "25.00", "0.50")',
      );
    }
    const [integerPart = ''] = amount.split('.');
    if (integerPart.length > MAX_INTEGER_DIGITS) {
      throw new InvalidMoneyError(
        `Valor "${amount}" excede ${MAX_INTEGER_DIGITS} dígitos inteiros`,
      );
    }
    // O formato já garantiu as 2 casas, então tirar o ponto dá os centavos.
    return BigInt(amount.replace('.', ''));
  }

  /** 2500n → "25.00"; -1000n → "-10.00"; 5n → "0.05". */
  private static formatCents(cents: bigint): string {
    const sign = cents < 0n ? '-' : '';
    const abs = cents < 0n ? -cents : cents;
    const integerPart = abs / CENTS_PER_UNIT;
    const fractionPart = (abs % CENTS_PER_UNIT).toString().padStart(2, '0');
    return `${sign}${integerPart}.${fractionPart}`;
  }
}

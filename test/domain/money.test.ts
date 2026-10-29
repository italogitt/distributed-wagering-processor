import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { CurrencyMismatchError, DomainError, InvalidMoneyError } from '../../src/domain/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money.from', () => {
  test.each(['25.00', '0.50', '0.05', '0.00', '1.00', '999999999999999999.99'])(
    'aceita "%s" e devolve a mesma grafia',
    (amount) => {
      expect(brl(amount).toJSON()).toEqual({ amount, currency: 'BRL' });
    },
  );

  test.each([
    ['25', 'sem casas decimais'],
    ['25.5', '1 casa decimal'],
    ['1.005', '3 casas decimais'],
    ['1e3', 'notação científica'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['', 'string vazia'],
    [' 25.00', 'espaço à esquerda'],
    ['25.00 ', 'espaço à direita'],
    ['25.00\n', 'quebra de linha no fim'],
    ['-25.00', 'negativo'],
    ['+25.00', 'sinal de +'],
    ['025.00', 'zero à esquerda'],
    ['00.00', 'zero à esquerda no zero'],
    ['.50', 'sem parte inteira'],
    ['25.', 'sem parte decimal'],
    ['25,00', 'vírgula como separador'],
    ['1_000.00', 'separador de milhar'],
    ['0x10.00', 'hexadecimal'],
    ['١٢.٠٠', 'dígitos não ASCII'],
  ])('rejeita "%s" (%s)', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejeita mais de 18 dígitos inteiros (limite do numeric(20,2))', () => {
    expect(() => brl('1000000000000000000.00')).toThrow(InvalidMoneyError);
    expect(() => brl('1000000000000000000.00')).toThrow('excede 18 dígitos inteiros');
  });

  test('rejeita amount que não é string (payload sem tipo em runtime)', () => {
    const props = { amount: 25 as unknown as string, currency: 'BRL' };
    expect(() => Money.from(props)).toThrow(InvalidMoneyError);
  });

  test.each(['USD', 'EUR'])('aceita a moeda %s', (currency) => {
    expect(Money.from({ amount: '1.00', currency }).currency).toBe(currency);
  });

  test.each([
    ['brl', 'formato ISO-4217'],
    ['BR', 'formato ISO-4217'],
    ['BRLL', 'formato ISO-4217'],
    ['', 'formato ISO-4217'],
    [' BRL', 'formato ISO-4217'],
    ['XYZ', 'não aceita'],
    ['GBP', 'não aceita'],
  ])('rejeita a moeda "%s" (%s)', (currency, reason) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(reason);
  });

  test('a mensagem de erro diz o motivo', () => {
    expect(() => brl('25.5')).toThrow('exatamente 2 casas decimais');
  });
});

describe('Money.zero', () => {
  test('cria zero na moeda pedida', () => {
    const zero = Money.zero('BRL');
    expect(zero.isZero()).toBe(true);
    expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test('valida a moeda', () => {
    expect(() => Money.zero('XYZ')).toThrow(InvalidMoneyError);
  });
});

describe('aritmética', () => {
  test('add é exata (o 0.1 + 0.2 do float)', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
  });

  test('add com vai-um nos centavos', () => {
    expect(brl('0.99').add(brl('0.01')).toJSON().amount).toBe('1.00');
  });

  test('add soma valores no limite sem perder precisão', () => {
    const max = brl('999999999999999999.99');
    expect(max.add(brl('0.01')).toJSON().amount).toBe('1000000000000000000.00');
  });

  test('subtract simples', () => {
    expect(brl('25.00').subtract(brl('10.50')).toJSON().amount).toBe('14.50');
  });

  test('subtract pode dar negativo (saldo insuficiente)', () => {
    const result = brl('20.00').subtract(brl('30.00'));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON()).toEqual({ amount: '-10.00', currency: 'BRL' });
  });

  test('negativo menor que 1 formata com zero inteiro', () => {
    expect(brl('0.00').subtract(brl('0.05')).toJSON().amount).toBe('-0.05');
  });

  test('negate inverte o sinal', () => {
    expect(brl('10.00').negate().toJSON().amount).toBe('-10.00');
    expect(brl('10.00').negate().negate().toJSON().amount).toBe('10.00');
  });

  test('negate de zero continua zero (sem "-0.00")', () => {
    const negZero = Money.zero('BRL').negate();
    expect(negZero.isZero()).toBe(true);
    expect(negZero.isNegative()).toBe(false);
    expect(negZero.toJSON().amount).toBe('0.00');
  });

  test('é imutável: as operações não alteram os operandos', () => {
    const a = brl('10.00');
    const b = brl('3.00');
    const sum = a.add(b);
    a.subtract(b);
    a.negate();
    expect(sum).not.toBe(a);
    expect(a.toJSON().amount).toBe('10.00');
    expect(b.toJSON().amount).toBe('3.00');
  });
});

describe('comparações', () => {
  test('isZero / isPositive / isNegative', () => {
    const zero = brl('0.00');
    const pos = brl('0.01');
    const neg = pos.negate();
    expect([zero.isZero(), zero.isPositive(), zero.isNegative()]).toEqual([true, false, false]);
    expect([pos.isZero(), pos.isPositive(), pos.isNegative()]).toEqual([false, true, false]);
    expect([neg.isZero(), neg.isPositive(), neg.isNegative()]).toEqual([false, false, true]);
  });

  test('isLessThan', () => {
    expect(brl('9.99').isLessThan(brl('10.00'))).toBe(true);
    expect(brl('10.00').isLessThan(brl('10.00'))).toBe(false);
    expect(brl('10.01').isLessThan(brl('10.00'))).toBe(false);
    expect(brl('1.00').negate().isLessThan(brl('0.00'))).toBe(true);
  });

  test('equals compara valor e moeda', () => {
    expect(brl('10.00').equals(brl('10.00'))).toBe(true);
    expect(brl('10.00').equals(brl('10.01'))).toBe(false);
  });

  test('equals com moedas diferentes devolve false, sem lançar', () => {
    expect(brl('10.00').equals(usd('10.00'))).toBe(false);
  });
});

describe('conflito de moeda', () => {
  const ops: Array<[string, (a: Money, b: Money) => unknown]> = [
    ['add', (a, b) => a.add(b)],
    ['subtract', (a, b) => a.subtract(b)],
    ['isLessThan', (a, b) => a.isLessThan(b)],
  ];

  test.each(ops)('%s entre BRL e USD lança CurrencyMismatchError', (_name, op) => {
    expect(() => op(brl('10.00'), usd('10.00'))).toThrow(CurrencyMismatchError);
  });

  test('o erro é um DomainError e carrega as duas moedas', () => {
    try {
      brl('1.00').add(usd('1.00'));
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toBeInstanceOf(CurrencyMismatchError);
      const mismatch = error as CurrencyMismatchError;
      expect(mismatch.name).toBe('CurrencyMismatchError');
      expect([mismatch.left, mismatch.right]).toEqual(['BRL', 'USD']);
    }
  });
});

describe('serialização', () => {
  test('toString traz valor e moeda', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
    expect(brl('0.05').toString()).toBe('0.05 BRL');
    expect(brl('0.00').subtract(brl('10.00')).toString()).toBe('-10.00 BRL');
  });

  test('JSON.stringify funciona (o bigint não vaza)', () => {
    expect(JSON.stringify(brl('25.00'))).toBe('{"amount":"25.00","currency":"BRL"}');
    expect(JSON.stringify({ balance: brl('0.05') })).toBe(
      '{"balance":{"amount":"0.05","currency":"BRL"}}',
    );
  });

  test('toJSON → from devolve um Money igual (ida e volta)', () => {
    const original = brl('1234.56');
    expect(Money.from(original.toJSON()).equals(original)).toBe(true);
  });

  test('erro de entrada é InvalidMoneyError e DomainError', () => {
    try {
      brl('abc');
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as Error).name).toBe('InvalidMoneyError');
    }
  });
});

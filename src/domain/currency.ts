/**
 * Moedas aceitas pelo domínio. O banco só valida o formato `^[A-Z]{3}$` (D7);
 * quem barra uma moeda fora da lista é o domínio.
 *
 * O desafio poderia usar só BRL, mas USD e EUR entram para que o conflito de
 * moedas seja testável.
 */
export const SUPPORTED_CURRENCIES: readonly string[] = ['BRL', 'USD', 'EUR'];

const ISO_4217_FORMAT = /^[A-Z]{3}$/;

export function isIso4217Format(currency: string): boolean {
  return ISO_4217_FORMAT.test(currency);
}

export function isSupportedCurrency(currency: string): boolean {
  return SUPPORTED_CURRENCIES.includes(currency);
}

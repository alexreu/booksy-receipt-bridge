/**
 * Readers for the numeric formats Booksy prints, in French convention.
 *
 * These PARSE, they never compute. `parseMoney('300,00 €') === 300` is a
 * transcription of what the document says; nothing here derives a value from
 * another (plan section 31).
 */

/**
 * `300,00 €`, `1 234,56 €`, `-20,00 €`.
 *
 * Thousands may be grouped with a space, a non-breaking space or a dot. The
 * minus may be ASCII or U+2212. The space before the euro sign is optional
 * because it is a plain space on real receipts but could be a NBSP elsewhere.
 */
// Thousands may be grouped with a space, a non-breaking space, a narrow
// no-break space or a dot. Written as escapes rather than literal characters:
// an invisible byte inside a regex is unreviewable in a diff.
const MONEY = /^([-\u2212+]?)(\d{1,3}(?:[\u0020\u00a0\u202f.]\d{3})*|\d+),(\d{2})\s*€$/;

/** `20%`, `5,5 %`, `20.0%`. */
const RATE = /^(\d+(?:[.,]\d+)?)\s*%$/;

/** `x1`, `x 2`, `x1,5`. */
const QUANTITY = /^x\s*(\d+(?:[.,]\d+)?)$/i;

export function isMoney(text: string): boolean {
  return MONEY.test(text.trim());
}

export function parseMoney(text: string): number | undefined {
  const match = MONEY.exec(text.trim());
  if (match === null) return undefined;
  const [, sign, whole, cents] = match;
  const digits = (whole ?? '').replace(/[\u0020\u00a0\u202f.]/g, '');
  const value = Number(`${digits}.${cents ?? '00'}`);
  if (Number.isNaN(value)) return undefined;
  return sign === '-' || sign === '−' ? -value : value;
}

export function isRate(text: string): boolean {
  return RATE.test(text.trim());
}

export function parseRate(text: string): number | undefined {
  const match = RATE.exec(text.trim());
  if (match === null) return undefined;
  const value = Number((match[1] ?? '').replace(',', '.'));
  return Number.isNaN(value) ? undefined : value;
}

export function isQuantity(text: string): boolean {
  return QUANTITY.test(text.trim());
}

export function parseQuantity(text: string): number | undefined {
  const match = QUANTITY.exec(text.trim());
  if (match === null) return undefined;
  const value = Number((match[1] ?? '').replace(',', '.'));
  return Number.isNaN(value) ? undefined : value;
}

/** Two amounts agree to the cent. Used only to raise warnings, never to correct. */
export function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

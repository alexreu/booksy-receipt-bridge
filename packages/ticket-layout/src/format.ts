/**
 * DISPLAY-ONLY formatting.
 *
 * These helpers never compute a value; they render a number that was read from
 * the source document (plan section 31). French convention: comma decimal
 * separator, narrow space before the euro sign.
 */

export function formatAmount(value: number): string {
  return value.toFixed(2).replace('.', ',');
}

export function formatMoney(value: number): string {
  return `${formatAmount(value)} €`;
}

export function formatRate(value: number): string {
  const text = Number.isInteger(value) ? String(value) : formatAmount(value);
  return `${text} %`;
}

export function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : formatAmount(value);
}

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * ISO timestamps become dd/mm/yyyy hh:mm; anything else is passed through.
 *
 * Reformats the LITERAL components and never converts a time zone. Going through
 * `new Date` would re-express the instant in the machine's local zone, so a
 * receipt issued at 15:09 could print as 19:09 - a changed fiscal value, which
 * plan section 31 forbids. Time zone reconciliation, if it is ever needed, is a
 * parser decision, not a formatting one.
 */
export function formatDateTime(value: string): string {
  const match = ISO_DATE_TIME.exec(value.trim());
  if (match === null) return value;
  const [, year, month, day, hour, minute] = match;
  return `${day}/${month}/${year} ${hour}:${minute}`;
}

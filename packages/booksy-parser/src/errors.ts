import type { ParseWarning } from '@brb/shared';

/**
 * Thrown when the document cannot yield a printable receipt.
 *
 * The parser deliberately throws rather than returning a Receipt with a
 * fabricated total: a 0,00 € ticket that looks well-formed is far more dangerous
 * than a refusal. The native host maps `code` onto NOT_BOOKSY / INVALID_RECEIPT.
 */
export class BooksyParseError extends Error {
  constructor(
    readonly code: 'NOT_BOOKSY' | 'INVALID_RECEIPT',
    message: string,
    readonly warnings: ParseWarning[] = [],
  ) {
    super(message);
    this.name = 'BooksyParseError';
  }
}

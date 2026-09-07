/**
 * Booksy receipt parser.
 *
 * Reads a Booksy PDF into the fiscal model. It is label- and type-driven rather
 * than position-driven: see `cells.ts` for why column geometry is not trusted.
 *
 * It never recomputes a fiscal value (plan section 31). Where the document
 * disagrees with itself, a ParseWarning is raised and the printed value is kept.
 */
export type { ParseResult, ParseWarning, ParseWarningCode, Receipt } from '@brb/shared';

export { ANCHORS, countDetectionSignals, isBooksyReceipt } from './anchors.ts';
export { BooksyParseError } from './errors.ts';
export { classifyCell, toCells, type Cell, type CellKind } from './cells.ts';
export { isMoney, parseMoney, parseQuantity, parseRate } from './money.ts';
export { parseBooksyReceipt, parseReceiptFromItems } from './parse.ts';

/** Confidence below which auto-print must refuse (plan section 34). */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.9;

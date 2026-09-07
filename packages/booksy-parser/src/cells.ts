import type { PdfTextItem } from '@brb/pdf-inspector';
import { isMoney, isQuantity, isRate } from './money.ts';

/**
 * Cell classification by CONTENT TYPE rather than by column position.
 *
 * The real receipt's columns are only ~2 pt from the midpoint boundary between
 * two headers, so assigning cells geometrically is a coin flip the moment a font
 * metric or a template width changes. The columns are, however, distinct by
 * type: an index reads "1.", a quantity "x1", a VAT code "T2000", a rate "20%",
 * an amount "300,00 €". Position is then only needed to order the two amount
 * columns, where left is the unit price and right is the line total.
 */
export type CellKind = 'index' | 'quantity' | 'vatCode' | 'rate' | 'money' | 'text';

const INDEX = /^\d+\.$/;
/**
 * Shape of a Booksy VAT code, observed as a letter plus four digits ("T2000").
 *
 * Applied alongside the set of codes the VAT table declared, not only as a
 * fallback: an item can carry a code the table has no row for, and treating it
 * as prose would both lose the code and append it to the service label. The
 * trade-off is that a label consisting solely of a code-shaped token would be
 * misread - which the AMBIGUOUS_FIELD warning then surfaces.
 */
const VAT_CODE_SHAPE = /^[A-Z]{1,3}\d{2,6}$/;

export interface Cell {
  kind: CellKind;
  text: string;
  x: number;
  xEnd: number;
}

export function classifyCell(text: string, knownVatCodes: ReadonlySet<string>): CellKind {
  const trimmed = text.trim();
  if (INDEX.test(trimmed)) return 'index';
  if (isQuantity(trimmed)) return 'quantity';
  if (isMoney(trimmed)) return 'money';
  if (isRate(trimmed)) return 'rate';
  if (knownVatCodes.has(trimmed) || VAT_CODE_SHAPE.test(trimmed)) return 'vatCode';
  return 'text';
}

export function toCells(
  line: readonly PdfTextItem[],
  knownVatCodes: ReadonlySet<string> = new Set(),
): Cell[] {
  return line
    .filter((item) => item.isWhitespace !== true && item.text.trim() !== '')
    .map((item) => ({
      kind: classifyCell(item.text, knownVatCodes),
      text: item.text.trim(),
      x: item.x,
      xEnd: item.x + item.width,
    }))
    .sort((a, b) => a.x - b.x);
}

export function cellsOf(cells: readonly Cell[], kind: CellKind): Cell[] {
  return cells.filter((cell) => cell.kind === kind);
}

/** Joined text of the plain-text cells, in reading order. */
export function textOf(cells: readonly Cell[]): string {
  return cellsOf(cells, 'text')
    .map((cell) => cell.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

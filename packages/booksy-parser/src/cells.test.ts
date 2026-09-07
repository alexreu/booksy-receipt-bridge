import { describe, expect, it } from 'vitest';
import { classifyCell, textOf, toCells } from './cells.ts';
import type { PdfTextItem } from '@brb/pdf-inspector';

const NO_CODES = new Set<string>();

describe('classifyCell', () => {
  it('recognises each column of the item table by its content', () => {
    expect(classifyCell('1.', NO_CODES)).toBe('index');
    expect(classifyCell('x1', NO_CODES)).toBe('quantity');
    expect(classifyCell('300,00 €', NO_CODES)).toBe('money');
    expect(classifyCell('20%', NO_CODES)).toBe('rate');
    expect(classifyCell('Montant libre', NO_CODES)).toBe('text');
  });

  it('trusts the VAT codes the document itself declared', () => {
    const codes = new Set(['T2000', 'T1000']);
    expect(classifyCell('T2000', codes)).toBe('vatCode');
    // Without the declared set, the shape rule stands in.
    expect(classifyCell('T2000', NO_CODES)).toBe('vatCode');
  });

  it('reads a code-shaped cell even when the VAT table has no row for it', () => {
    // An item may carry a code the VAT table does not list. Treating it as prose
    // would lose the code and glue it onto the service label; the missing rate
    // is reported as a warning instead.
    expect(classifyCell('T9999', new Set(['T2000']))).toBe('vatCode');
    expect(classifyCell('T9999', NO_CODES)).toBe('vatCode');
  });

  it('does not mistake ordinary prose for a VAT code', () => {
    for (const text of ['Coupe', 'Montant libre', 'Total HT', 'x1', '1.']) {
      expect(classifyCell(text, new Set(['T2000']))).not.toBe('vatCode');
    }
  });

  it('classifies an amount before a rate, so "20%" cannot shadow money', () => {
    expect(classifyCell('20,00 €', NO_CODES)).toBe('money');
  });
});

describe('toCells', () => {
  const line: PdfTextItem[] = [
    item('300,00 €', 528),
    item('1.', 30),
    item(' ', 40, true),
    item('Montant libre', 113),
    item('T2000', 426),
  ];

  it('orders cells left to right and drops the synthetic gaps', () => {
    expect(toCells(line, new Set(['T2000'])).map((cell) => cell.text)).toEqual([
      '1.',
      'Montant libre',
      'T2000',
      '300,00 €',
    ]);
  });

  it('keeps only the plain-text cells in the label', () => {
    expect(textOf(toCells(line, new Set(['T2000'])))).toBe('Montant libre');
  });

  it('returns nothing for an empty line', () => {
    expect(toCells([])).toEqual([]);
    expect(textOf([])).toBe('');
  });
});

function item(text: string, x: number, isWhitespace = false): PdfTextItem {
  return {
    text,
    x,
    y: 600,
    yTop: 200,
    width: text.length * 6,
    height: 10,
    page: 1,
    ...(isWhitespace ? { isWhitespace: true } : {}),
  };
}

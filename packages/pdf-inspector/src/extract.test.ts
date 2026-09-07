import { describe, expect, it } from 'vitest';
import { groupIntoLines, inspectPdf, linesToText } from './extract.ts';
import { makeSyntheticPdf, syntheticReceiptPdf } from './testing/make-pdf.ts';
import type { PdfTextItem } from './types.ts';

describe('inspectPdf', () => {
  it('reports every page', async () => {
    const result = await inspectPdf(syntheticReceiptPdf());
    expect(result.pageCount).toBe(2);
    expect(result.pages.map((page) => page.page)).toEqual([1, 2]);
    expect(result.pages[0]?.width).toBeCloseTo(595.28, 1);
    expect(result.pages[0]?.height).toBeCloseTo(841.89, 1);
  });

  it('extracts the text of every run', async () => {
    const result = await inspectPdf(syntheticReceiptPdf());
    const texts = result.items.map((item) => item.text);
    expect(texts).toContain('SALON DEMO');
    expect(texts).toContain('TOTAL TTC');
    expect(texts).toContain('73,50');
    expect(texts).toContain('NF525 signature ABCDEF0123456789');
  });

  it('tags each run with its 1-based page', async () => {
    const result = await inspectPdf(syntheticReceiptPdf());
    const nf525 = result.items.find((item) => item.text.startsWith('NF525'));
    expect(nf525?.page).toBe(2);
  });

  it('keeps both coordinate systems consistent', async () => {
    const result = await inspectPdf(syntheticReceiptPdf());
    const header = must(result.items.find((item) => item.text === 'SALON DEMO'));
    const total = must(result.items.find((item) => item.text === 'TOTAL TTC'));

    // The header sits above the total on the page.
    // In raw PDF space y grows upwards, so header.y is the larger number...
    expect(header.y).toBeGreaterThan(total.y);
    // ...while yTop grows downwards, so the header is the smaller number.
    expect(header.yTop).toBeLessThan(total.yTop);
  });

  it('measures every run, including the synthetic gaps', async () => {
    // pdf.js reports height 0 for its whitespace runs; the inspector recovers the
    // font size from the text matrix so yTop stays on the same line as its peers.
    const result = await inspectPdf(syntheticReceiptPdf());
    for (const item of result.items) {
      expect(item.width).toBeGreaterThan(0);
      expect(item.height).toBeGreaterThan(0);
    }
  });

  it('puts a column gap on the same line as the text around it', async () => {
    const result = await inspectPdf(syntheticReceiptPdf());
    const gap = must(result.items.find((item) => item.isWhitespace === true));
    const total = must(result.items.find((item) => item.text === 'TOTAL TTC'));
    const gapOnTotalLine = must(
      result.items.find(
        (item) => item.isWhitespace === true && Math.abs(item.yTop - total.yTop) < 2,
      ),
    );
    expect(gap.text.trim()).toBe('');
    expect(gapOnTotalLine.x).toBeGreaterThan(total.x);
  });

  it('flags a PDF with no text layer as a probable scan', async () => {
    const blank = makeSyntheticPdf([[]]);
    const result = await inspectPdf(blank);
    expect(result.items).toEqual([]);
    expect(result.looksLikeScan).toBe(true);
  });

  it('does not flag a PDF that has text', async () => {
    const result = await inspectPdf(syntheticReceiptPdf());
    expect(result.looksLikeScan).toBe(false);
  });

  it('does not consume the caller buffer', async () => {
    // pdf.js takes ownership of the array it is handed, so the inspector copies.
    // Without the copy the second call here throws on a detached buffer.
    const data = syntheticReceiptPdf();
    await inspectPdf(data);
    const second = await inspectPdf(data);
    expect(second.items.length).toBeGreaterThan(0);
  });
});

describe('groupIntoLines', () => {
  it('groups runs that share a baseline and orders them left to right', () => {
    const items = fakeItems([
      { text: 'right', x: 480, yTop: 100 },
      { text: 'left', x: 60, yTop: 100.5 },
      { text: 'below', x: 60, yTop: 130 },
    ]);
    expect(linesToText(groupIntoLines(items))).toEqual(['left right', 'below']);
  });

  it('never merges runs from different pages', () => {
    const items = fakeItems([
      { text: 'page one', x: 60, yTop: 100, page: 1 },
      { text: 'page two', x: 60, yTop: 100, page: 2 },
    ]);
    const lines = groupIntoLines(items);
    expect(lines).toHaveLength(2);
    expect(linesToText(lines)).toEqual(['page one', 'page two']);
  });

  it('honours the tolerance', () => {
    const items = fakeItems([
      { text: 'a', x: 10, yTop: 100 },
      { text: 'b', x: 20, yTop: 103 },
    ]);
    expect(groupIntoLines(items, 1)).toHaveLength(2);
    expect(groupIntoLines(items, 5)).toHaveLength(1);
  });

  it('recovers the receipt lines of the fixture', async () => {
    const result = await inspectPdf(syntheticReceiptPdf());
    const text = linesToText(groupIntoLines(result.items));
    expect(text).toContain('TOTAL TTC 73,50');
    expect(text).toContain('Coupe 25,00');
    expect(text).toContain('TVA 20% 12,25');
  });

  it('returns nothing for no input', () => {
    expect(groupIntoLines([])).toEqual([]);
    expect(linesToText([])).toEqual([]);
  });

  it('drops the synthetic column-gap runs by default', () => {
    const items = fakeItems([
      { text: 'Coupe', x: 60, yTop: 100 },
      { text: ' ', x: 90, yTop: 100, width: 390, isWhitespace: true },
      { text: '25,00', x: 480, yTop: 100 },
    ]);
    expect(linesToText(groupIntoLines(items))).toEqual(['Coupe 25,00']);
  });

  it('can keep the column-gap runs on request', () => {
    const items = fakeItems([
      { text: 'Coupe', x: 60, yTop: 100 },
      { text: ' ', x: 90, yTop: 100, width: 390, isWhitespace: true },
      { text: '25,00', x: 480, yTop: 100 },
    ]);
    const lines = groupIntoLines(items, { includeWhitespace: true });
    expect(lines[0]).toHaveLength(3);
  });

  it('produces no empty lines for the fixture', async () => {
    // Regression: the column-gap runs used to land on a line of their own, which
    // came out of linesToText as an empty string.
    const result = await inspectPdf(syntheticReceiptPdf());
    expect(linesToText(groupIntoLines(result.items))).not.toContain('');
  });
});

function fakeItems(
  partials: readonly (Partial<PdfTextItem> & { text: string })[],
): PdfTextItem[] {
  return partials.map((partial) => ({
    x: 0,
    y: 0,
    yTop: 0,
    width: 10,
    height: 10,
    page: 1,
    ...partial,
  }));
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture is missing an expected run');
  return value;
}

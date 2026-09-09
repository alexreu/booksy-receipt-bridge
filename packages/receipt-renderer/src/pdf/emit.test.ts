import { describe, expect, it } from 'vitest';
import { buildTicketLayout, layoutToLines, nominalReceipt } from '@brb/ticket-layout';
import { contentStream, emitPdf, escapeText, paginate, toRows } from './emit.ts';

const LAYOUT = buildTicketLayout(nominalReceipt(), { columns: 42 });
const OPTIONS = { paperWidth: 80, printableWidth: 72 };

function asText(pdf: Uint8Array): string {
  return Array.from(pdf, (byte) => String.fromCharCode(byte)).join('');
}

describe('toRows', () => {
  it('prints the rows the thermal printer would, in the same order', () => {
    // The whole point: one geometry, two devices. If these ever diverge, the
    // sheet stops being a picture of the ticket.
    expect(toRows(LAYOUT).map((row) => row.text)).toEqual(layoutToLines(LAYOUT));
  });

  it('keeps bold and double width, which carry the totals', () => {
    const emphasised = toRows(LAYOUT).filter((row) => row.bold || row.doubleWidth);
    expect(emphasised.length).toBeGreaterThan(0);
  });
});

describe('escapeText', () => {
  it('escapes what would otherwise end the PDF string', () => {
    expect(escapeText('a(b)c\\d')).toBe('a\\(b\\)c\\\\d');
  });

  it('writes the accents a French receipt needs, in WinAnsi', () => {
    // é is 0xE9 and the euro sign is 0x80 in WinAnsi - the encoding the font is
    // declared with, so these are the bytes Courier will look up.
    expect(escapeText('é')).toBe('\\351');
    expect(escapeText('€')).toBe('\\200');
  });

  it('substitutes what the encoding cannot represent rather than break', () => {
    expect(escapeText('漢')).toBe('?');
  });
});

describe('paginate', () => {
  it('keeps a receipt on one sheet', () => {
    expect(paginate(toRows(LAYOUT), 8)).toHaveLength(1);
  });

  it('starts a second sheet rather than printing past the edge', () => {
    const many = Array.from({ length: 400 }, () => ({
      text: 'x',
      bold: false,
      doubleWidth: false,
      doubleHeight: false,
    }));
    expect(paginate(many, 10).length).toBeGreaterThan(1);
  });
});

describe('emitPdf', () => {
  const pdf = emitPdf(LAYOUT, OPTIONS);
  const text = asText(pdf);

  it('is a PDF, opened by its header and closed by its trailer', () => {
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('declares one xref entry per object plus the free one', () => {
    // A wrong count is the classic way a hand-written PDF opens nowhere except
    // in the viewer it was written against.
    const declared = Number(/xref\n0 (\d+)/.exec(text)?.[1]);
    const entries = [...text.matchAll(/^\d{10} \d{5} [nf] $/gm)].length;
    expect(entries).toBe(declared);
  });

  it('points every xref offset at the object it claims', () => {
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
    offsets.forEach((offset, index) => {
      expect(text.slice(offset, offset + 12)).toContain(`${index + 1} 0 obj`);
    });
  });

  it('asks for Courier, because the ticket is a character grid', () => {
    expect(text).toContain('/BaseFont /Courier');
    expect(text).toContain('/BaseFont /Courier-Bold');
    expect(text).toContain('/Encoding /WinAnsiEncoding');
  });

  it('sizes the type so the columns span the printable width', () => {
    // 42 columns of Courier at 0.6 em must measure 72 mm, which is 8.10 pt.
    expect(text).toContain('8.10 Tf');
  });

  it('draws the ticket rather than a reflow of the page', () => {
    const ticketNumber = layoutToLines(LAYOUT).find((line) => line.includes('Ticket'));
    expect(ticketNumber).toBeDefined();
    expect(text).toContain(escapeText(ticketNumber ?? ''));
  });

  it('keeps a double-height row inside the paper', () => {
    // Found on paper, not in a test: scaling the font size doubles the width
    // too, and the title ran past the 80 mm guide. A thermal printer doubles
    // the height alone, so the horizontal scale is halved back.
    const doubled = contentStream(
      [{ text: 'TOTAL', bold: false, doubleWidth: false, doubleHeight: true }],
      { fontSize: 8, left: 36, top: 800, guideWidth: 226 },
    );
    expect(doubled).toContain('16.00 Tf');
    expect(doubled).toContain('50 Tz');
  });

  it('leaves an A4 sheet, whatever the ticket', () => {
    expect(text).toContain('/MediaBox [0 0 595.28 841.89]');
  });
});

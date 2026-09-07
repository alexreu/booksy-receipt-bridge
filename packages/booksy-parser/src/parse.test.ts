import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PdfInspection, PdfTextItem } from '@brb/pdf-inspector';
import { makeSyntheticPdf } from '@brb/pdf-inspector/testing';
import { isBooksyReceipt } from './anchors.ts';
import { BooksyParseError } from './errors.ts';
import { parseBooksyReceipt, parseReceiptFromItems } from './parse.ts';

/**
 * The fixture carries the GEOMETRY of a real Booksy receipt with the
 * identifying strings replaced (see scripts/anonymize-inspection.ts). Real
 * receipts contain customer data and are gitignored, but that geometry is
 * exactly what the parser reasons about, so testing against a hand-invented
 * layout would prove nothing.
 */
const FIXTURE_JSON = new URL('../../../fixtures/booksy/recu-1167.anon.json', import.meta.url);
const FIXTURE_PDF = new URL('../../../fixtures/booksy/recu-1167.anon.pdf', import.meta.url);

let fixture: PdfTextItem[];

beforeAll(async () => {
  const inspection = JSON.parse(await readFile(FIXTURE_JSON, 'utf8')) as PdfInspection;
  fixture = inspection.items;
});

describe('isBooksyReceipt', () => {
  it('accepts a real Booksy receipt', () => {
    expect(isBooksyReceipt(fixture)).toBe(true);
  });

  it('rejects a document with no text layer, i.e. a scan', () => {
    expect(isBooksyReceipt([])).toBe(false);
  });

  it('rejects an unrelated PDF - AC17', () => {
    const invoice = itemsFrom([
      'FACTURE N 2026-0042',
      'Societe Exemple SARL',
      'Montant a payer 1 200,00 EUR',
      'Merci de votre confiance',
    ]);
    expect(isBooksyReceipt(invoice)).toBe(false);
  });

  it('is not fooled by a single Booksy-looking line', () => {
    // A filename is not proof and neither is one line (plan section 20).
    expect(isBooksyReceipt(itemsFrom(['Total TTC 10,00 EUR']))).toBe(false);
  });
});

describe('parseReceiptFromItems - the real receipt', () => {
  it('reads it with full confidence and no warnings', () => {
    const { confidence, warnings } = parseReceiptFromItems(fixture);
    expect(confidence).toBe(1);
    expect(warnings).toEqual([]);
  });

  it('reads the ticket identity', () => {
    const { receipt } = parseReceiptFromItems(fixture);
    expect(receipt.source).toBe('booksy');
    expect(receipt.ticket).toEqual({
      number: '1167',
      operationType: 'Vente',
      issuedAt: '11/08/2026, 16:08:54',
    });
  });

  it('reads the merchant block', () => {
    const { receipt } = parseReceiptFromItems(fixture);
    expect(receipt.merchant).toEqual({
      name: 'SALON EXEMPLE COIFFURE',
      siret: '00000000000000',
      vatNumber: 'FR00000000000',
      nafCode: '930D',
      address: ['1 Rue Exemple Quartier Témoin, 00000, VILLE EXEMPLE, France'],
    });
  });

  it('reads the customer identifier', () => {
    expect(parseReceiptFromItems(fixture).receipt.customer).toEqual({ id: '00000000' });
  });

  // AC8
  it('reads the items exactly as printed, rate joined from the VAT table', () => {
    const { receipt } = parseReceiptFromItems(fixture);
    expect(receipt.items).toEqual([
      {
        label: 'Montant libre',
        quantity: 1,
        unitPrice: 300,
        total: 300,
        vatCode: 'T2000',
        vatRate: 20,
      },
    ]);
  });

  // AC9
  it('reads the printed total TTC', () => {
    expect(parseReceiptFromItems(fixture).receipt.totals.totalTTC).toBe(300);
  });

  it('reads the subtotal from the VAT table Total HT column, not by summing', () => {
    expect(parseReceiptFromItems(fixture).receipt.totals.subtotal).toBe(250);
  });

  // AC10
  it('reads the VAT lines', () => {
    expect(parseReceiptFromItems(fixture).receipt.vat).toEqual([
      { rate: 20, amount: 50, base: 250 },
    ]);
  });

  it('reads the payment method without its redundant timestamp', () => {
    // Booksy prints "Carte bancaire <bullet> 11/08/2026, 16:08:54"; the
    // timestamp is already ticket.issuedAt, and 37 characters would push the
    // amount off an 80 mm line.
    expect(parseReceiptFromItems(fixture).receipt.payment).toEqual({
      method: 'Carte bancaire',
      amount: 300,
    });
  });

  // AC11
  it('keeps the NF525 block', () => {
    expect(parseReceiptFromItems(fixture).receipt.certification).toEqual({
      software: 'Booksy Biz 6.4337',
      certification: '(NF525)_B_0000-0_XxxX',
      signatureTimestamp: '11/08/2026, 16:08:54',
    });
  });

  it('does not invent a signature that the document does not carry', () => {
    // Real receipts have a signature TIMESTAMP and no signature value. Scoring
    // must not require one, or every genuine receipt falls below the threshold.
    const { receipt, confidence } = parseReceiptFromItems(fixture);
    expect(receipt.certification?.signature).toBeUndefined();
    expect(confidence).toBe(1);
  });

  it('does not leak table headers or the page footer into any field', () => {
    const serialised = JSON.stringify(parseReceiptFromItems(fixture).receipt);
    expect(serialised).not.toContain('Page 1/1');
    expect(serialised).not.toContain('Nom de la prestation');
    expect(serialised).not.toContain('Prix unitaire');
  });

  it('matches the snapshot', () => {
    expect(parseReceiptFromItems(fixture).receipt).toMatchSnapshot();
  });
});

describe('parseBooksyReceipt - the PDF entry point', () => {
  it('parses a PDF buffer to the same receipt as the items', async () => {
    const buffer = new Uint8Array(await readFile(FIXTURE_PDF));
    const fromPdf = await parseBooksyReceipt(buffer);
    expect(fromPdf.receipt).toEqual(parseReceiptFromItems(fixture).receipt);
    expect(fromPdf.confidence).toBe(1);
  });

  it('refuses a PDF with no text layer', async () => {
    const blank = makeSyntheticPdf([[]]);
    await expect(parseBooksyReceipt(blank)).rejects.toThrow(BooksyParseError);
    await expect(parseBooksyReceipt(blank)).rejects.toMatchObject({ code: 'NOT_BOOKSY' });
  });
});

describe('parseReceiptFromItems - refusals', () => {
  it('refuses a document that is not a Booksy receipt', () => {
    const invoice = itemsFrom(['FACTURE', '1 200,00 EUR']);
    expect(() => parseReceiptFromItems(invoice)).toThrow(BooksyParseError);
    try {
      parseReceiptFromItems(invoice);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toMatchObject({ code: 'NOT_BOOKSY' });
    }
  });

  it('refuses rather than printing a total it could not read', () => {
    // Passes detection, but the Total TTC line carries no amount. Emitting a
    // well-formed-looking 0,00 ticket would be worse than refusing.
    const broken = itemsFrom([
      'Ticket n 42',
      "Type d'operation: Vente",
      'Nom de la prestation ou du produit',
      'Total TTC',
      '(NF525)_B_0000-0_XxxX',
    ]);
    try {
      parseReceiptFromItems(broken);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(BooksyParseError);
      expect(error).toMatchObject({ code: 'INVALID_RECEIPT' });
    }
  });
});

describe('parseReceiptFromItems - warnings, never corrections', () => {
  it('reports a total that disagrees with the lines and keeps the printed one', () => {
    const tampered = replaceOnLineOf(fixture, 'Total TTC', '300,00', '999,00');
    const { receipt, warnings } = parseReceiptFromItems(tampered);

    expect(receipt.totals.totalTTC).toBe(999);
    expect(receipt.items[0]?.total).toBe(300);
    const codes = warnings.map((warning) => warning.code);
    expect(codes).toContain('ITEMS_SUM_MISMATCH');
    expect(codes).toContain('VAT_SUM_MISMATCH');
  });

  it('reports a payment amount that differs from the total', () => {
    const tampered = replaceOnLineOf(fixture, 'Montant total', '300,00', '250,00');
    const { receipt, warnings } = parseReceiptFromItems(tampered);
    expect(receipt.payment?.amount).toBe(250);
    expect(receipt.totals.totalTTC).toBe(300);
    expect(warnings.map((warning) => warning.code)).toContain('AMBIGUOUS_FIELD');
  });
});

describe('parseReceiptFromItems - layout variations', () => {
  it('joins an item label that wrapped onto a second row', () => {
    const items = itemsFrom([
      'Ticket n 7',
      "Type d'operation: Vente",
      'Nom de la prestation ou du produit|Quantite|Code TVA|Total',
      'Prix unitaire',
      'brut',
      '1.|Coloration complete avec balayage|x1|T2000|189,90 €|189,90 €',
      'et soin reparateur profond',
      'Total TTC|189,90 €',
      'Code TVA|Taux de TVA|Montant TVA|Total HT|Total TTC',
      'T2000|20%|31,65 €|158,25 €|189,90 €',
      '(NF525)_B_0000-0_XxxX',
    ]);
    const { receipt } = parseReceiptFromItems(items);
    expect(receipt.items).toHaveLength(1);
    expect(receipt.items[0]?.label).toBe(
      'Coloration complete avec balayage et soin reparateur profond',
    );
    expect(receipt.items[0]?.total).toBe(189.9);
  });

  it('reads several VAT rates and joins each item to its own', () => {
    const items = itemsFrom([
      'Ticket n 8',
      "Type d'operation: Vente",
      'Nom de la prestation ou du produit|Quantite|Code TVA|Total',
      '1.|Coupe|x1|T2000|30,00 €|30,00 €',
      '2.|Cafe|x2|T1000|2,50 €|5,00 €',
      'Total TTC|35,00 €',
      'Code TVA|Taux de TVA|Montant TVA|Total HT|Total TTC',
      'T2000|20%|5,00 €|25,00 €|30,00 €',
      'T1000|10%|0,45 €|4,55 €|5,00 €',
      '5,45 €|29,55 €|35,00 €',
      '(NF525)_B_0000-0_XxxX',
    ]);
    const { receipt, warnings } = parseReceiptFromItems(items);

    expect(receipt.vat).toEqual([
      { rate: 20, amount: 5, base: 25 },
      { rate: 10, amount: 0.45, base: 4.55 },
    ]);
    expect(receipt.items.map((item) => [item.label, item.vatCode, item.vatRate])).toEqual([
      ['Coupe', 'T2000', 20],
      ['Cafe', 'T1000', 10],
    ]);
    // Read from the table's own totals row, not summed.
    expect(receipt.totals.subtotal).toBe(29.55);
    // The synthetic document has no merchant block and no date, so those
    // warnings are expected. What must not appear is a consistency complaint.
    const codes = warnings.map((warning) => warning.code);
    expect(codes).not.toContain('ITEMS_SUM_MISMATCH');
    expect(codes).not.toContain('VAT_SUM_MISMATCH');
    expect(codes).not.toContain('AMBIGUOUS_FIELD');
  });

  it('flags an item whose VAT code has no row in the VAT table', () => {
    const items = itemsFrom([
      'Ticket n 9',
      "Type d'operation: Vente",
      'Nom de la prestation ou du produit|Quantite|Code TVA|Total',
      '1.|Coupe|x1|T9999|30,00 €|30,00 €',
      'Total TTC|30,00 €',
      'Code TVA|Taux de TVA|Montant TVA|Total HT|Total TTC',
      'T2000|20%|5,00 €|25,00 €|30,00 €',
      '(NF525)_B_0000-0_XxxX',
    ]);
    const { receipt, warnings } = parseReceiptFromItems(items);
    expect(receipt.items[0]?.vatCode).toBe('T9999');
    expect(receipt.items[0]?.vatRate).toBeUndefined();
    expect(warnings.map((warning) => warning.code)).toContain('AMBIGUOUS_FIELD');
  });

  it('drops confidence below the auto-print threshold when blocks are missing', () => {
    const items = itemsFrom([
      'Ticket n 10',
      "Type d'operation: Vente",
      'Nom de la prestation ou du produit|Quantite|Code TVA|Total',
      '1.|Coupe|x1|30,00 €',
      'Total TTC|30,00 €',
    ]);
    const { confidence, warnings } = parseReceiptFromItems(items);
    expect(confidence).toBeLessThan(0.9);
    expect(warnings.map((warning) => warning.code)).toContain('UNEXPECTED_LAYOUT');
  });
});

// --- helpers ---------------------------------------------------------------

/**
 * Build text runs from a list of lines, 12 pt apart.
 *
 * A line may declare its cells with `|`, which become separate runs spread
 * across the page - that is what a table row looks like to the extractor. The
 * separator is not a space because an amount contains one.
 */
function itemsFrom(lines: readonly string[]): PdfTextItem[] {
  const out: PdfTextItem[] = [];
  lines.forEach((line, index) => {
    const yTop = 30 + index * 12;
    const cells = line.split('|');
    const step = cells.length <= 1 ? 0 : 500 / cells.length;
    cells.forEach((text, cellIndex) => {
      out.push({
        text,
        x: 30 + cellIndex * step,
        y: 841 - yTop,
        yTop,
        width: text.length * 6,
        height: 10,
        page: 1,
      });
    });
  });
  return out;
}

/**
 * Change an amount, but only on the topmost line containing `lineMarker`.
 *
 * Amounts repeat across a receipt, so a blind search-and-replace would tamper
 * with several blocks at once and the test would stop proving anything.
 */
function replaceOnLineOf(
  items: readonly PdfTextItem[],
  lineMarker: string,
  from: string,
  to: string,
): PdfTextItem[] {
  const anchor = [...items]
    .filter((item) => item.text.includes(lineMarker))
    .sort((a, b) => a.yTop - b.yTop)[0];
  if (anchor === undefined) throw new Error(`fixture has no line containing ${lineMarker}`);
  return items.map((item) =>
    Math.abs(item.yTop - anchor.yTop) <= 2 && item.text.includes(from)
      ? { ...item, text: item.text.replace(from, to) }
      : item,
  );
}

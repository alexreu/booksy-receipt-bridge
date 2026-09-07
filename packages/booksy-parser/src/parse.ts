import { groupIntoLines, inspectPdf, linesToText } from '@brb/pdf-inspector';
import type { PdfTextItem } from '@brb/pdf-inspector';
import type {
  ParseResult,
  ParseWarning,
  Receipt,
  ReceiptItem,
  VatLine,
} from '@brb/shared';
import { ANCHORS, isBooksyReceipt } from './anchors.ts';
import { type Cell, cellsOf, textOf, toCells } from './cells.ts';
import { BooksyParseError } from './errors.ts';
import { parseMoney, parseQuantity, parseRate, sameAmount } from './money.ts';

/** Parse a Booksy receipt PDF. Throws BooksyParseError if it is not one. */
export async function parseBooksyReceipt(buffer: Uint8Array): Promise<ParseResult> {
  const inspection = await inspectPdf(buffer);
  if (inspection.looksLikeScan) {
    throw new BooksyParseError(
      'NOT_BOOKSY',
      'Ce PDF ne contient aucune couche texte (probablement un scan).',
    );
  }
  return parseReceiptFromItems(inspection.items);
}

/**
 * Parse from already-extracted text runs.
 *
 * Split out from the PDF entry point so the parser can be tested against a
 * committed fixture of real geometry - real receipts carry customer data and
 * cannot live in the repository.
 */
export function parseReceiptFromItems(items: readonly PdfTextItem[]): ParseResult {
  if (!isBooksyReceipt(items)) {
    throw new BooksyParseError('NOT_BOOKSY', "Ce document n'est pas un reçu Booksy.");
  }

  const warnings: ParseWarning[] = [];
  const lines = groupIntoLines(items);
  const texts = linesToText(lines);

  const find = (pattern: RegExp): number => texts.findIndex((text) => pattern.test(text));
  const capture = (pattern: RegExp): string | undefined => {
    for (const text of texts) {
      const match = pattern.exec(text);
      if (match !== null) return match[1]?.trim();
    }
    return undefined;
  };

  // --- tables -------------------------------------------------------------
  // The VAT table is read first: it is what supplies the set of real VAT codes,
  // which is how an item's code cell is recognised without guessing at column
  // geometry.
  const vatTable = parseVatTable(lines, texts, warnings);
  const knownVatCodes = new Set(vatTable.lines.map((line) => line.code).filter(isString));
  const rateByCode = new Map(
    vatTable.lines.filter((line) => line.code !== undefined).map((line) => [line.code, line.rate]),
  );

  const items_ = parseItems(lines, texts, knownVatCodes, rateByCode, warnings);

  // --- totals -------------------------------------------------------------
  const totalTtcIndex = find(ANCHORS.totalTtc);
  const totalTTC =
    totalTtcIndex === -1 ? undefined : firstMoney(toCells(lines[totalTtcIndex] ?? []));

  if (totalTTC === undefined) {
    throw new BooksyParseError(
      'INVALID_RECEIPT',
      "Le total TTC est illisible : refus plutôt que d'imprimer un montant inventé.",
      warnings,
    );
  }

  // --- merchant -----------------------------------------------------------
  const merchant = parseMerchant(texts, warnings);

  // --- ticket -------------------------------------------------------------
  const ticketNumber = capture(ANCHORS.ticketNumber);
  if (ticketNumber === undefined) {
    warnings.push({
      code: 'MISSING_FIELD',
      field: 'ticket.number',
      message: 'Numéro de ticket introuvable.',
    });
  }
  const issuedAt = findCreationDate(items);
  if (issuedAt === undefined) {
    warnings.push({
      code: 'MISSING_FIELD',
      field: 'ticket.issuedAt',
      message: 'Date de création introuvable.',
    });
  }

  // --- payment ------------------------------------------------------------
  const payment = parsePayment(lines, texts);

  // --- certification ------------------------------------------------------
  const software = capture(ANCHORS.software);
  const certificationRef = texts.find((text) => ANCHORS.certification.test(text));
  const signatureTimestamp = capture(ANCHORS.signatureTimestamp);
  const certification =
    software === undefined && certificationRef === undefined && signatureTimestamp === undefined
      ? undefined
      : {
          ...(software === undefined ? {} : { software }),
          ...(certificationRef === undefined ? {} : { certification: certificationRef }),
          ...(signatureTimestamp === undefined ? {} : { signatureTimestamp }),
        };
  if (certification === undefined) {
    warnings.push({
      code: 'MISSING_FIELD',
      field: 'certification',
      message: 'Aucune donnée de certification NF525 trouvée.',
    });
  }

  const customerId = capture(ANCHORS.customerId);

  const receipt: Receipt = {
    source: 'booksy',
    ticket: {
      number: ticketNumber ?? '',
      ...(capture(ANCHORS.operationType) === undefined
        ? {}
        : { operationType: capture(ANCHORS.operationType) }),
      ...(issuedAt === undefined ? {} : { issuedAt }),
    },
    merchant,
    ...(customerId === undefined ? {} : { customer: { id: customerId } }),
    items: items_,
    totals: {
      ...(vatTable.subtotal === undefined ? {} : { subtotal: vatTable.subtotal }),
      totalTTC,
    },
    vat: vatTable.lines.map(({ code: _code, ...line }) => line),
    ...(payment === undefined ? {} : { payment }),
    ...(certification === undefined ? {} : { certification }),
  };

  addConsistencyWarnings(receipt, vatTable, warnings);

  return { receipt, confidence: score(receipt), warnings };
}

// ---------------------------------------------------------------------------

interface VatTableRow extends VatLine {
  code?: string;
}

interface VatTable {
  lines: VatTableRow[];
  /** "Total HT" from the table's own totals row - read, never summed. */
  subtotal?: number;
  /** "Total TTC" from the totals row, used only to cross-check. */
  totalTTC?: number;
  /** "Montant TVA" from the totals row, used only to cross-check. */
  vatTotal?: number;
}

/**
 * Read the VAT summary table.
 *
 * Columns are Code | Taux | Montant TVA | Total HT | Total TTC. A row carrying a
 * code and a rate is a VAT line; a row of amounts only is the table's own totals
 * row, which is where `subtotal` comes from. Amounts are taken in left-to-right
 * order, which is the only place position matters.
 */
function parseVatTable(
  lines: readonly PdfTextItem[][],
  texts: readonly string[],
  warnings: ParseWarning[],
): VatTable {
  const headerIndex = texts.findIndex(
    (text) => ANCHORS.vatTableHeader.test(text) && ANCHORS.vatTableHeaderRate.test(text),
  );
  if (headerIndex === -1) {
    warnings.push({
      code: 'UNEXPECTED_LAYOUT',
      field: 'vat',
      message: 'Table de TVA introuvable.',
    });
    return { lines: [] };
  }

  const rows: VatTableRow[] = [];
  const table: VatTable = { lines: rows };

  for (let index = headerIndex + 1; index < lines.length; index++) {
    const cells = toCells(lines[index] ?? []);
    if (cells.length === 0) continue;

    const money = cellsOf(cells, 'money')
      .map((cell) => parseMoney(cell.text))
      .filter(isNumber);
    const rateCell = cellsOf(cells, 'rate')[0];
    const codeCell = cellsOf(cells, 'vatCode')[0];

    if (rateCell !== undefined && money.length >= 1) {
      const rate = parseRate(rateCell.text);
      if (rate === undefined) continue;
      rows.push({
        ...(codeCell === undefined ? {} : { code: codeCell.text }),
        rate,
        amount: money[0] ?? 0,
        ...(money[1] === undefined ? {} : { base: money[1] }),
      });
      continue;
    }

    // Amounts with no code and no rate: the table's totals row. It closes the
    // table.
    if (rows.length > 0 && money.length >= 2 && textOf(cells) === '') {
      table.vatTotal = money[0];
      table.subtotal = money[1];
      table.totalTTC = money[2];
      break;
    }

    if (rows.length > 0) break;
  }

  if (rows.length === 0) {
    warnings.push({
      code: 'MISSING_FIELD',
      field: 'vat',
      message: 'Aucune ligne de TVA lue.',
    });
  }
  return table;
}

/**
 * Read the item table.
 *
 * Runs from the table header to the "Total TTC" line. A row needs at least one
 * amount to be an item; text-only rows are header remnants before the first
 * item ("Prix unitaire", "brut") and label continuations after it, since a long
 * service name wraps onto a second row.
 */
function parseItems(
  lines: readonly PdfTextItem[][],
  texts: readonly string[],
  knownVatCodes: ReadonlySet<string>,
  rateByCode: ReadonlyMap<string | undefined, number>,
  warnings: ParseWarning[],
): ReceiptItem[] {
  const headerIndex = texts.findIndex((text) => ANCHORS.itemTableHeader.test(text));
  if (headerIndex === -1) {
    warnings.push({
      code: 'UNEXPECTED_LAYOUT',
      field: 'items',
      message: 'Table des prestations introuvable.',
    });
    return [];
  }

  let endIndex = texts.findIndex((text) => ANCHORS.totalTtc.test(text));
  if (endIndex === -1 || endIndex <= headerIndex) endIndex = lines.length;

  const items: ReceiptItem[] = [];

  for (let index = headerIndex + 1; index < endIndex; index++) {
    const cells = toCells(lines[index] ?? [], knownVatCodes);
    if (cells.length === 0) continue;

    const money = cellsOf(cells, 'money')
      .map((cell) => parseMoney(cell.text))
      .filter(isNumber);
    const label = textOf(cells);

    if (money.length === 0) {
      const previous = items[items.length - 1];
      if (previous === undefined) continue; // header remnant
      if (label === '' || ANCHORS.itemTableHeaderFragment.test(label)) continue;
      previous.label = `${previous.label} ${label}`.trim();
      continue;
    }

    // Two amounts: unit gross price then line total, left to right. One amount:
    // the line total.
    const total = money[money.length - 1];
    if (total === undefined) continue;
    const unitPrice = money.length >= 2 ? money[0] : undefined;

    const quantityCell = cellsOf(cells, 'quantity')[0];
    const quantity =
      quantityCell === undefined ? undefined : parseQuantity(quantityCell.text);
    const vatCode = cellsOf(cells, 'vatCode')[0]?.text;
    const vatRate = vatCode === undefined ? undefined : rateByCode.get(vatCode);

    if (vatCode !== undefined && vatRate === undefined) {
      warnings.push({
        code: 'AMBIGUOUS_FIELD',
        field: `items[${items.length}].vatRate`,
        message: `Le code TVA ${vatCode} n'a pas de taux dans la table de TVA.`,
      });
    }

    items.push({
      label,
      ...(quantity === undefined ? {} : { quantity }),
      ...(unitPrice === undefined ? {} : { unitPrice }),
      total,
      ...(vatCode === undefined ? {} : { vatCode }),
      ...(vatRate === undefined ? {} : { vatRate }),
    });
  }

  if (items.length === 0) {
    warnings.push({
      code: 'MISSING_FIELD',
      field: 'items',
      message: 'Aucune prestation ni produit lu.',
    });
  }
  return items;
}

/**
 * Read the merchant block.
 *
 * The name is the line directly above the first identity label, and the address
 * is whatever sits between the last identity label and the item table. Both are
 * relative positions, so a reordered or extended block still reads.
 */
function parseMerchant(texts: readonly string[], warnings: ParseWarning[]): Receipt['merchant'] {
  const labelPatterns = [ANCHORS.siret, ANCHORS.vatNumber, ANCHORS.nafCode];
  const labelIndexes = texts
    .map((text, index) => (labelPatterns.some((pattern) => pattern.test(text)) ? index : -1))
    .filter((index) => index !== -1);

  const capture = (pattern: RegExp): string | undefined => {
    for (const text of texts) {
      const match = pattern.exec(text);
      if (match !== null) return match[1]?.trim();
    }
    return undefined;
  };

  const firstLabel = labelIndexes[0];
  const lastLabel = labelIndexes[labelIndexes.length - 1];
  const name = firstLabel === undefined ? undefined : texts[firstLabel - 1]?.trim();

  if (name === undefined || name === '') {
    warnings.push({
      code: 'MISSING_FIELD',
      field: 'merchant.name',
      message: 'Nom de l’établissement introuvable.',
    });
  }

  let address: string[] = [];
  if (lastLabel !== undefined) {
    const tableStart = texts.findIndex(
      (text, index) =>
        index > lastLabel &&
        (ANCHORS.itemTableHeader.test(text) || ANCHORS.itemTableHeaderFragment.test(text)),
    );
    address = texts
      .slice(lastLabel + 1, tableStart === -1 ? lastLabel + 1 : tableStart)
      .map((text) => text.trim())
      .filter((text) => text !== '');
  }

  const siret = capture(ANCHORS.siret);
  const vatNumber = capture(ANCHORS.vatNumber);
  const nafCode = capture(ANCHORS.nafCode);

  return {
    name: name ?? '',
    ...(siret === undefined ? {} : { siret }),
    ...(vatNumber === undefined ? {} : { vatNumber }),
    ...(nafCode === undefined ? {} : { nafCode }),
    ...(address.length === 0 ? {} : { address }),
  };
}

/**
 * Read the payment summary.
 *
 * The amount comes from the "Montant total payé" line. The method is the text of
 * the nearest amount-bearing line above it, cut at the bullet: Booksy prints
 * "Carte bancaire • 11/08/2026, 16:08:54" and the timestamp is already carried
 * by `ticket.issuedAt`, so repeating it would only push the amount off the line
 * on an 80 mm ticket.
 */
function parsePayment(
  lines: readonly PdfTextItem[][],
  texts: readonly string[],
): Receipt['payment'] {
  const paidIndex = texts.findIndex((text) => ANCHORS.totalPaid.test(text));
  if (paidIndex === -1) return undefined;

  const amount = firstMoney(toCells(lines[paidIndex] ?? []));

  let method: string | undefined;
  for (let index = paidIndex - 1; index >= 0 && index >= paidIndex - 5; index--) {
    const text = texts[index] ?? '';
    if (ANCHORS.summary.test(text)) break;
    const cells = toCells(lines[index] ?? []);
    const label = textOf(cells);
    if (cellsOf(cells, 'money').length > 0 && label !== '') {
      method = (label.split('•')[0] ?? label).trim();
      break;
    }
  }

  if (method === undefined && amount === undefined) return undefined;
  return {
    ...(method === undefined ? {} : { method }),
    ...(amount === undefined ? {} : { amount }),
  };
}

/**
 * Find the creation date.
 *
 * Booksy puts the label in the right-hand column with the value on the NEXT
 * line, so this is the one field that has to be read spatially: take the nearest
 * run below the label whose horizontal span overlaps it.
 */
function findCreationDate(items: readonly PdfTextItem[]): string | undefined {
  const label = items.find(
    (item) => ANCHORS.creationDateLabel.test(item.text) && item.isWhitespace !== true,
  );
  if (label === undefined) return undefined;

  // The value may sit on the same line, after the label.
  const inline = /Date\s+de\s+cr[ée]ation\s*:\s*(.+)$/i.exec(label.text);
  if (inline !== null) return inline[1]?.trim();

  const labelStart = label.x;
  const labelEnd = label.x + label.width;

  const below = items
    .filter(
      (item) =>
        item.isWhitespace !== true &&
        item.page === label.page &&
        item.yTop > label.yTop &&
        item.text.trim() !== '' &&
        item.x + item.width > labelStart &&
        item.x < labelEnd,
    )
    .sort((a, b) => a.yTop - b.yTop);

  return below[0]?.text.trim();
}

/**
 * Cross-checks.
 *
 * These sums exist ONLY to raise a warning. Nothing here writes back into the
 * receipt: section 31 forbids recomputing a fiscal value, not noticing that the
 * document disagrees with itself.
 */
function addConsistencyWarnings(
  receipt: Receipt,
  vatTable: VatTable,
  warnings: ParseWarning[],
): void {
  if (receipt.items.length > 0) {
    const itemsTotal = receipt.items.reduce((sum, item) => sum + item.total, 0);
    if (!sameAmount(itemsTotal, receipt.totals.totalTTC)) {
      warnings.push({
        code: 'ITEMS_SUM_MISMATCH',
        field: 'totals.totalTTC',
        message:
          `La somme des lignes (${itemsTotal.toFixed(2)}) diffère du total TTC ` +
          `imprimé (${receipt.totals.totalTTC.toFixed(2)}). Le total imprimé est conservé.`,
      });
    }
  }

  if (vatTable.totalTTC !== undefined && !sameAmount(vatTable.totalTTC, receipt.totals.totalTTC)) {
    warnings.push({
      code: 'VAT_SUM_MISMATCH',
      field: 'vat',
      message:
        `Le total TTC de la table de TVA (${vatTable.totalTTC.toFixed(2)}) diffère du ` +
        `total TTC imprimé (${receipt.totals.totalTTC.toFixed(2)}).`,
    });
  }

  if (receipt.payment?.amount !== undefined && !sameAmount(receipt.payment.amount, receipt.totals.totalTTC)) {
    warnings.push({
      code: 'AMBIGUOUS_FIELD',
      field: 'payment.amount',
      message: 'Le montant payé diffère du total TTC.',
    });
  }
}

/**
 * Confidence (plan section 34).
 *
 * Weighted presence of the fields that make a receipt printable. Note what is
 * NOT required: a signature string. Real Booksy receipts carry a signature
 * TIMESTAMP and no signature value, so demanding one would put every genuine
 * receipt below the auto-print threshold.
 */
function score(receipt: Receipt): number {
  const checks: Array<[number, boolean]> = [
    [0.2, receipt.ticket.number !== ''],
    [0.15, receipt.merchant.name !== ''],
    [0.2, receipt.items.length > 0],
    [0.2, Number.isFinite(receipt.totals.totalTTC)],
    [0.15, receipt.vat.length > 0],
    [
      0.1,
      receipt.certification?.software !== undefined ||
        receipt.certification?.certification !== undefined,
    ],
  ];
  const total = checks.reduce((sum, [weight, ok]) => sum + (ok ? weight : 0), 0);
  return Math.round(total * 100) / 100;
}

function firstMoney(cells: readonly Cell[]): number | undefined {
  for (const cell of cellsOf(cells, 'money')) {
    const value = parseMoney(cell.text);
    if (value !== undefined) return value;
  }
  return undefined;
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined;
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

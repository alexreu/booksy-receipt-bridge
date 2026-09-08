import type { Receipt } from '@brb/shared';
import {
  formatDateTime,
  formatMoney,
  formatQuantity,
  formatRate,
} from './format.ts';
import type {
  Align,
  TicketLayout,
  TicketLayoutOptions,
  TicketLine,
  TicketStyle,
} from './types.ts';

/** 80 mm paper, 72 mm printable, Font A on a TM-T88V. */
export const DEFAULT_COLUMNS = 42;

/**
 * Turn a parsed receipt into a printable layout.
 *
 * Every field present on the Receipt reaches the ticket. Nothing is dropped to
 * make room and nothing is recomputed - long labels wrap, they are not truncated.
 */
export function buildTicketLayout(
  receipt: Receipt,
  options: TicketLayoutOptions = {},
): TicketLayout {
  const columns = options.columns ?? DEFAULT_COLUMNS;
  const lines: TicketLine[] = [];

  const text = (value: string, align?: Align, style?: TicketStyle): void => {
    lines.push({ kind: 'text', text: value, ...(align ? { align } : {}), ...(style ? { style } : {}) });
  };
  const twoCol = (left: string, right: string, bold = false): void => {
    lines.push({ kind: 'two-col', left, right, ...(bold ? { style: { bold: true } } : {}) });
  };
  const separator = (char?: string): void => {
    lines.push({ kind: 'separator', ...(char ? { char } : {}) });
  };

  // --- merchant -----------------------------------------------------------
  text(receipt.merchant.name, 'center', { bold: true, doubleHeight: true });
  for (const addressLine of receipt.merchant.address ?? []) {
    text(addressLine, 'center');
  }
  if (receipt.merchant.siret !== undefined) text(`SIRET ${receipt.merchant.siret}`, 'center');
  if (receipt.merchant.vatNumber !== undefined) {
    text(`TVA ${receipt.merchant.vatNumber}`, 'center');
  }
  if (receipt.merchant.nafCode !== undefined) text(`NAF ${receipt.merchant.nafCode}`, 'center');

  if (options.duplicate === true) {
    lines.push({ kind: 'feed', lines: 1 });
    text('* DUPLICATA *', 'center', { bold: true });
  }

  separator();

  // --- ticket identity ----------------------------------------------------
  text(`Ticket n\u00b0 ${receipt.ticket.number}`, 'center', { bold: true });
  if (receipt.ticket.issuedAt !== undefined) {
    text(formatDateTime(receipt.ticket.issuedAt), 'center');
  }
  if (receipt.ticket.operationType !== undefined) {
    text(receipt.ticket.operationType, 'center');
  }
  if (receipt.customer?.name !== undefined) twoCol('Client', receipt.customer.name);
  if (receipt.customer?.id !== undefined) twoCol('Client n\u00b0', receipt.customer.id);

  separator();

  // --- items --------------------------------------------------------------
  for (const item of receipt.items) {
    text(item.label);
    const detail = itemDetail(item.quantity, item.unitPrice, item.vatRate);
    twoCol(detail === '' ? ' ' : `  ${detail}`, formatMoney(item.total));
  }

  separator();

  // --- totals -------------------------------------------------------------
  if (receipt.totals.subtotal !== undefined) {
    twoCol('Sous-total', formatMoney(receipt.totals.subtotal));
  }
  lines.push({
    kind: 'two-col',
    left: 'TOTAL TTC',
    right: formatMoney(receipt.totals.totalTTC),
    style: { bold: true },
  });

  // --- VAT ----------------------------------------------------------------
  if (receipt.vat.length > 0) {
    lines.push({ kind: 'feed', lines: 1 });
    text('TVA');
    for (const vatLine of receipt.vat) {
      const base = vatLine.base === undefined ? '' : ` sur ${formatMoney(vatLine.base)}`;
      twoCol(`  ${formatRate(vatLine.rate)}${base}`, formatMoney(vatLine.amount));
    }
  }

  // --- payment ------------------------------------------------------------
  if (receipt.payment !== undefined) {
    lines.push({ kind: 'feed', lines: 1 });
    const method = receipt.payment.method ?? 'Paiement';
    if (receipt.payment.amount === undefined) text(method);
    else twoCol(method, formatMoney(receipt.payment.amount));
  }

  // --- NF525 certification ------------------------------------------------
  if (receipt.certification !== undefined) {
    const { software, softwareId, certification, signatureTimestamp, signature } =
      receipt.certification;
    separator();
    // Labelled rather than bare: on a real receipt "Booksy Biz 6.4337" and a
    // lone timestamp are unreadable out of context, and this block is the part
    // an inspection would look at.
    if (software !== undefined) text(`Logiciel : ${software}`);
    if (softwareId !== undefined) text(`Id logiciel : ${softwareId}`);
    // The certification reference identifies itself: it begins with "(NF525)".
    if (certification !== undefined) text(certification);
    if (signatureTimestamp !== undefined) text(`Horodatage : ${signatureTimestamp}`);
    if (signature !== undefined) {
      text('Signature');
      text(signature);
    }
  }

  lines.push({ kind: 'feed', lines: 3 }, { kind: 'cut' });

  return { columns, lines };
}

function itemDetail(
  quantity: number | undefined,
  unitPrice: number | undefined,
  vatRate: number | undefined,
): string {
  const parts: string[] = [];
  if (quantity !== undefined && unitPrice !== undefined) {
    parts.push(`${formatQuantity(quantity)} x ${formatMoney(unitPrice)}`);
  } else if (quantity !== undefined) {
    parts.push(`x ${formatQuantity(quantity)}`);
  } else if (unitPrice !== undefined) {
    parts.push(formatMoney(unitPrice));
  }
  if (vatRate !== undefined) parts.push(`TVA ${formatRate(vatRate)}`);
  // Single space: a double space survives on an unwrapped line but collapses on a
  // wrapped one, which made neighbouring detail lines disagree.
  return parts.join(' ');
}

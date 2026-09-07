import type { DetectedReceipt } from '../downloads/store.ts';

/**
 * How a detected receipt reads in the popup.
 *
 * Pure, like the rest of the popup's logic, so the wording and the states are
 * testable without a DOM.
 */
export interface DetectedRow {
  downloadId: number;
  label: string;
  detail: string;
  printed: boolean;
  /** Shown when the parse was uncertain or noisy, so the user can look first. */
  caution?: string;
}

/**
 * Money, formatted locally.
 *
 * A three-line copy rather than importing @brb/ticket-layout, which would drag
 * the whole layout engine into the extension bundle for one string.
 */
export function formatMoney(value: number): string {
  return `${value.toFixed(2).replace('.', ',')} €`;
}

/** Confidence below which the popup suggests looking before printing. */
export const CAUTION_THRESHOLD = 0.9;

export function detectedRows(receipts: readonly DetectedReceipt[]): DetectedRow[] {
  return receipts.map((receipt) => ({
    downloadId: receipt.downloadId,
    label: `Ticket n° ${receipt.ticketNumber} · ${formatMoney(receipt.totalTTC)}`,
    detail: detailOf(receipt),
    printed: receipt.printedAt !== undefined,
    ...caution(receipt),
  }));
}

function detailOf(receipt: DetectedReceipt): string {
  if (receipt.printedAt !== undefined) return 'déjà imprimé';
  return receipt.issuedAt ?? 'téléchargé à l’instant';
}

function caution(receipt: DetectedReceipt): { caution?: string } {
  if (receipt.printedAt !== undefined) return {};
  const notes: string[] = [];
  if (receipt.confidence < CAUTION_THRESHOLD) {
    notes.push(`lecture incertaine (${Math.round(receipt.confidence * 100)} %)`);
  }
  if (receipt.warningCount > 0) {
    notes.push(
      receipt.warningCount === 1 ? '1 anomalie signalée' : `${receipt.warningCount} anomalies signalées`,
    );
  }
  // Says where it came from only when the provenance was the weaker signal, so
  // the user knows the filename is what matched rather than Booksy itself.
  if (receipt.reason === 'filename') notes.push('reconnu par son nom de fichier');
  return notes.length === 0 ? {} : { caution: notes.join(' · ') };
}

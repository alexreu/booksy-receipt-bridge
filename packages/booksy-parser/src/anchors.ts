import type { PdfTextItem } from '@brb/pdf-inspector';

/**
 * Text markers used to locate the blocks of a Booksy receipt.
 *
 * Grouped here so that a Booksy template change is a one-file edit, and so the
 * detection heuristic and the parser cannot drift out of agreement about what a
 * Booksy receipt looks like.
 */
/**
 * Every accented letter is written as a class that also admits the unaccented
 * form. pdf.js recovers text through the PDF's own font encoding, and a badly
 * subsetted or non-standard encoding can hand back "operation" where the page
 * shows "opération". Refusing to recognise the document over a lost accent
 * would be a needless way to fail.
 */
export const ANCHORS = {
  ticketNumber: /Ticket\s*n\s*[°o]?\s*[:.]?\s*(\S+)/i,
  operationType: /Type\s+d['’]op[eé]ration\s*:\s*(.+)$/i,
  creationDateLabel: /Date\s+de\s+cr[eé]ation\s*:?/i,
  customerId: /Identifiant\s+client\s*:\s*(.+)$/i,
  siret: /SIRET\s*:\s*(.+)$/i,
  vatNumber: /N\s*[°o]?\s*TVA\s*:\s*(.+)$/i,
  nafCode: /Code\s*NAF\s*:\s*(.+)$/i,
  itemTableHeader: /Nom\s+de\s+la\s+prestation/i,
  itemTableHeaderFragment: /^(?:Prix\s+unitaire|brut|Quantit[eé]|Code\s+TVA|Total)$/i,
  vatTableHeader: /Code\s+TVA/i,
  vatTableHeaderRate: /Taux\s+de\s+TVA/i,
  totalTtc: /^Total\s+TTC\b/i,
  totalPaid: /Montant\s+total\s+pay[eé]/i,
  summary: /^R[eé]sum[eé]$/i,
  software: /Logiciel\s*:\s*(.+)$/i,
  certification: /^\(NF525\)\S*/,
  signatureTimestamp: /Horodatage\s+de\s+la\s+signature\s*:\s*(.+)$/i,
  pageFooter: /^Page\s+\d+\/\d+$/i,
} as const;

/**
 * Signals that identify the document as a Booksy receipt.
 *
 * A filename is not proof (plan section 20), and neither is any single line.
 * Requiring several independent markers is what keeps an unrelated PDF from
 * being parsed, let alone printed.
 */
const DETECTION_SIGNALS: RegExp[] = [
  ANCHORS.ticketNumber,
  ANCHORS.operationType,
  ANCHORS.itemTableHeader,
  ANCHORS.vatTableHeaderRate,
  ANCHORS.totalTtc,
  ANCHORS.certification,
  /Logiciel\s*:\s*Booksy/i,
];

export const MIN_DETECTION_SIGNALS = 3;

/**
 * How many independent Booksy markers the document carries.
 *
 * Tested run by run rather than against one joined string: several signals are
 * anchored to the start of a line, and against a joined haystack a `^` without
 * the multiline flag only ever matches the very first character of the document.
 */
export function countDetectionSignals(items: readonly PdfTextItem[]): number {
  const texts = items
    .filter((item) => item.isWhitespace !== true)
    .map((item) => item.text.trim());
  return DETECTION_SIGNALS.filter((signal) => texts.some((text) => signal.test(text))).length;
}

/**
 * Whether this document is a Booksy receipt.
 *
 * Called before anything is parsed, and again by the host before anything is
 * printed: AC17 says a non-Booksy PDF is never printed automatically.
 */
export function isBooksyReceipt(items: readonly PdfTextItem[]): boolean {
  if (items.length === 0) return false; // a scan has no text layer to read
  return countDetectionSignals(items) >= MIN_DETECTION_SIGNALS;
}

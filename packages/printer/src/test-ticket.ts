import type { TicketLayout } from '@brb/ticket-layout';
import type { PrinterConfig } from './types.ts';

/**
 * Diagnostic ticket for PRINT_TEST.
 *
 * Deliberately not built from a Receipt: it has to be printable before a parser
 * exists. The column ruler is the point - counting the digits that actually come
 * out tells you the printer's real column count, which is the single number the
 * whole layout depends on.
 */
export function buildTestTicketLayout(config: PrinterConfig): TicketLayout {
  const { columns } = config;
  const ruler = '1234567890'.repeat(Math.ceil(columns / 10)).slice(0, columns);

  return {
    columns,
    lines: [
      { kind: 'text', text: 'BOOKSY RECEIPT BRIDGE', align: 'center', style: { bold: true } },
      { kind: 'text', text: 'Test d’impression', align: 'center' },
      { kind: 'separator' },
      { kind: 'two-col', left: 'Imprimante', right: config.name },
      { kind: 'two-col', left: 'Papier', right: `${config.paperWidth} mm` },
      { kind: 'two-col', left: 'Zone imprimable', right: `${config.printableWidth} mm` },
      { kind: 'two-col', left: 'Colonnes attendues', right: String(columns) },
      { kind: 'separator' },
      { kind: 'text', text: 'Règle de colonnes' },
      { kind: 'text', text: ruler },
      { kind: 'text', text: `Le dernier chiffre doit être en bout de ligne.` },
      { kind: 'separator' },
      { kind: 'text', text: 'Caractères' },
      { kind: 'text', text: 'é è ê à â ç ù û î ï ô œ' },
      { kind: 'text', text: 'É È À Ç Ù Î Ô' },
      { kind: 'text', text: '12,50 € · 20 % · n° 996 · 25 °C' },
      { kind: 'separator' },
      { kind: 'text', text: 'Styles' },
      { kind: 'text', text: 'Gras', style: { bold: true } },
      { kind: 'text', text: 'Double hauteur', style: { doubleHeight: true } },
      { kind: 'text', text: 'Double largeur', style: { doubleWidth: true } },
      { kind: 'separator' },
      { kind: 'two-col', left: 'TOTAL TTC', right: '0,00 €', style: { bold: true } },
      { kind: 'feed', lines: 3 },
      { kind: 'cut' },
    ],
  };
}

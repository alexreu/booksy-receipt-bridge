import type { TicketLayout, TicketStyle } from '@brb/ticket-layout';
import { renderTicketLines } from '@brb/ticket-layout';

/**
 * HTML rendering of a ticket, for the on-screen PREVIEW.
 *
 * This is not the print path. Printing goes through ESC/POS, because a browser
 * or a Windows driver rescales an 80 mm document and that is the failure this
 * project exists to fix. What matters here is that the preview shows the SAME
 * character rows the printer will receive: both consume `renderTicketLines`, so
 * a preview that looks right is evidence about the paper, not a separate guess.
 */

export interface EmitHtmlOptions {
  /** Physical paper width in mm. */
  paperWidth?: number;
  /** Printable width in mm - the ticket body is centred inside the paper. */
  printableWidth?: number;
  title?: string;
  /**
   * Emit only the ticket element, with no document shell or <style>. For
   * embedding in a page that already has its own styling.
   */
  fragment?: boolean;
}

/**
 * Advance width of a monospace glyph as a fraction of the font size.
 *
 * 0.6 is the ratio of the common monospace faces (DejaVu Sans Mono, Menlo,
 * Consolas, Liberation Mono). It is used to solve for the font size that makes
 * `columns` characters span exactly `printableWidth`, which is the only way CSS
 * can be told "42 characters, this wide". A face with a different ratio shifts
 * the preview slightly; it cannot shift the print, which is byte-driven.
 */
const MONOSPACE_ADVANCE_RATIO = 0.6;

const FONT_STACK =
  "ui-monospace, 'DejaVu Sans Mono', 'Liberation Mono', Menlo, Consolas, monospace";

export function emitHtml(layout: TicketLayout, options: EmitHtmlOptions = {}): string {
  const paperWidth = options.paperWidth ?? 80;
  const printableWidth = options.printableWidth ?? 72;
  const fontSizeMm = printableWidth / layout.columns / MONOSPACE_ADVANCE_RATIO;

  const rows: string[] = [];
  for (const line of renderTicketLines(layout)) {
    if (line.kind === 'text') {
      for (const row of line.rows) rows.push(renderRow(row, line.style));
      continue;
    }
    if (line.kind === 'feed') {
      for (let index = 0; index < line.rows; index++) rows.push('<div class="row"></div>');
      continue;
    }
    rows.push('<div class="cut" role="separator" aria-label="coupe papier"></div>');
  }

  const ticket = `<div class="ticket">${rows.join('')}</div>`;
  if (options.fragment === true) return ticket;

  const title = escapeHtml(options.title ?? 'Ticket');
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
${styles(paperWidth, printableWidth, fontSizeMm)}
</style>
</head>
<body>
<div class="paper">${ticket}</div>
</body>
</html>
`;
}

function styles(paperWidth: number, printableWidth: number, fontSizeMm: number): string {
  return `@page {
  size: ${paperWidth}mm auto;
  margin: 0;
}

:root {
  color-scheme: light;
}

body {
  margin: 0;
  padding: 8mm 0;
  background: #e9e9ec;
  display: flex;
  justify-content: center;
}

.paper {
  width: ${paperWidth}mm;
  background: #fff;
  padding: 4mm 0;
  box-shadow: 0 1px 6px rgb(0 0 0 / 18%);
}

.ticket {
  width: ${printableWidth}mm;
  margin: 0 auto;
  font-family: ${FONT_STACK};
  font-size: ${round(fontSizeMm)}mm;
  line-height: 1.25;
  color: #000;
  /* The rows are already space-padded to the column grid by the layout layer,
     so the padding must survive rendering. */
  white-space: pre;
  font-variant-ligatures: none;
  -webkit-font-smoothing: none;
}

.row {
  min-height: 1.25em;
}

.row > span {
  display: inline-block;
  transform-origin: 0 0;
}

.cut {
  margin: 1.5mm 0;
  border-top: 1px dashed #9a9a9a;
}

@media print {
  body {
    padding: 0;
    background: #fff;
    display: block;
  }

  .paper {
    width: auto;
    padding: 0;
    box-shadow: none;
  }

  .cut {
    border-top-style: solid;
  }
}`;
}

/**
 * One character row.
 *
 * Double size is expressed as a font-size for the height and a horizontal scale
 * for the width, so that "double height" comes out tall and narrow exactly as
 * the printer renders it, rather than merely bigger.
 */
function renderRow(text: string, style?: TicketStyle): string {
  const width = style?.doubleWidth === true ? 2 : 1;
  const height = style?.doubleHeight === true ? 2 : 1;

  const declarations: string[] = [];
  if (style?.bold === true) declarations.push('font-weight:700');
  if (height !== 1) declarations.push(`font-size:${height}em`);
  if (width !== height) declarations.push(`transform:scaleX(${round(width / height)})`);

  // An empty row stays empty rather than becoming a space: `min-height` on
  // `.row` gives it its blank line, and the emitted rows then match
  // `layoutToLines` character for character, which is what the tests assert.
  const content = escapeHtml(text);
  if (declarations.length === 0) return `<div class="row">${content}</div>`;
  return `<div class="row"><span style="${declarations.join(';')}">${content}</span></div>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

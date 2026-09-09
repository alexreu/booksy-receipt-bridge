import type { TicketLayout } from '@brb/ticket-layout';
import { renderTicketLines } from '@brb/ticket-layout';

/**
 * The ticket as a PDF page, for a printer that is not thermal.
 *
 * WHY THIS EXISTS. ESC/POS is bytes for a thermal head. Sent to a laser or an
 * inkjet they come out as control codes printed as text. A receipt going to an
 * ordinary printer is therefore rendered instead: the SAME grid, at its real
 * width, drawn in the corner of an A4 sheet - an 80 mm ticket to cut out, not a
 * page-wide reflow.
 *
 * WHY A PDF WRITTEN BY HAND. The host is a single executable with no browser in
 * it (AC20), so nothing here can rasterise HTML. A PDF using the base-14
 * Courier is a few hundred bytes of structure: no dependency, no font file, no
 * rendering engine. Courier being monospaced is the whole point - a ticket's
 * geometry IS a character grid.
 *
 * WHAT IS FAITHFUL AND WHAT IS NOT. Every row, its wrapping, its alignment and
 * its width in columns are what the thermal printer would use: they come from
 * the same `renderTicketLines`. Bold and double width are drawn as such. The
 * paper is a sheet rather than a roll, so there is no cut - only a thin guide
 * showing where the 80 mm roll would end.
 */

/** A4 in points, the unit PDF measures in. */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 36;
const MM_TO_PT = 72 / 25.4;
/** Courier advances 0.6 em per glyph; that is what makes the grid computable. */
const COURIER_ADVANCE = 0.6;
const LINE_SPACING = 1.18;

export interface PdfOptions {
  /** Physical paper width in mm, for the cut guide. */
  paperWidth: number;
  /** Printable width in mm: the ticket's real column width. */
  printableWidth: number;
  title?: string;
}

export interface PdfRow {
  text: string;
  bold: boolean;
  doubleWidth: boolean;
  doubleHeight: boolean;
}

export function emitPdf(layout: TicketLayout, options: PdfOptions): Uint8Array {
  const columnWidth = options.printableWidth * MM_TO_PT;
  const fontSize = columnWidth / (layout.columns * COURIER_ADVANCE);
  const pages = paginate(toRows(layout), fontSize);

  const contents = pages.map((page) =>
    contentStream(page, {
      fontSize,
      left: MARGIN,
      top: PAGE_HEIGHT - MARGIN,
      guideWidth: options.paperWidth * MM_TO_PT,
    }),
  );

  return assemble(contents, options.title ?? 'Ticket');
}

/**
 * The rows the thermal printer would print, in order.
 *
 * `cut` is dropped rather than drawn: there is nothing to cut on a sheet, and a
 * dashed line pretending otherwise would be decoration.
 */
export function toRows(layout: TicketLayout): PdfRow[] {
  const rows: PdfRow[] = [];
  for (const line of renderTicketLines(layout)) {
    if (line.kind === 'text') {
      for (const text of line.rows) {
        rows.push({
          text,
          bold: line.style?.bold === true,
          doubleWidth: line.style?.doubleWidth === true,
          doubleHeight: line.style?.doubleHeight === true,
        });
      }
    } else if (line.kind === 'feed') {
      for (let index = 0; index < line.rows; index += 1) {
        rows.push({ text: '', bold: false, doubleWidth: false, doubleHeight: false });
      }
    }
  }
  return rows;
}

function heightOf(row: PdfRow, fontSize: number): number {
  return fontSize * LINE_SPACING * (row.doubleHeight ? 2 : 1);
}

/** Split into pages, because a long ticket is taller than a sheet. */
export function paginate(rows: readonly PdfRow[], fontSize: number): PdfRow[][] {
  const usable = PAGE_HEIGHT - 2 * MARGIN;
  const pages: PdfRow[][] = [[]];
  let used = 0;

  for (const row of rows) {
    const height = heightOf(row, fontSize);
    if (used + height > usable && (pages[pages.length - 1] ?? []).length > 0) {
      pages.push([]);
      used = 0;
    }
    pages[pages.length - 1]?.push(row);
    used += height;
  }
  return pages;
}

interface DrawOptions {
  fontSize: number;
  left: number;
  top: number;
  /** Where the paper's real edge falls, drawn as a thin guide to cut along. */
  guideWidth: number;
}

export function contentStream(rows: readonly PdfRow[], draw: DrawOptions): string {
  const guideRight = draw.left + draw.guideWidth;
  // The cut guide first, so text sits on top of it rather than the reverse.
  const parts: string[] = [
    '0.8 G',
    `${draw.left.toFixed(2)} ${MARGIN.toFixed(2)} m ${draw.left.toFixed(2)} ${draw.top.toFixed(2)} l S`,
    `${guideRight.toFixed(2)} ${MARGIN.toFixed(2)} m ${guideRight.toFixed(2)} ${draw.top.toFixed(2)} l S`,
    '0 G',
  ];

  let y = draw.top;
  for (const row of rows) {
    const size = draw.fontSize * (row.doubleHeight ? 2 : 1);
    y -= size * LINE_SPACING;
    if (row.text === '') continue;
    // Double height must not widen the glyphs. Scaling the font size doubles
    // both axes, so the horizontal scale is halved back - otherwise a doubled
    // title runs past the paper's edge, which is exactly what a thermal
    // printer would never do.
    const scale = (row.doubleWidth ? 200 : 100) / (row.doubleHeight ? 2 : 1);
    parts.push(
      'BT',
      `/${row.bold ? 'F2' : 'F1'} ${size.toFixed(2)} Tf`,
      `${scale} Tz`,
      `${draw.left.toFixed(2)} ${y.toFixed(2)} Td`,
      `(${escapeText(row.text)}) Tj`,
      'ET',
    );
  }
  return parts.join('\n');
}

/**
 * PDF string escaping, in the encoding Courier is asked for.
 *
 * WinAnsi covers the accents a French receipt uses, and the euro sign. Anything
 * it cannot represent becomes '?' rather than a broken byte - the same honesty
 * as the ESC/POS emitter, which reports what it substituted.
 */
export function escapeText(text: string): string {
  let out = '';
  for (const character of text) {
    const mapped = WIN_ANSI[character] ?? character.codePointAt(0) ?? 0x3f;
    const byte = mapped > 0xff ? 0x3f : mapped;
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 32 || byte > 126) out += `\\${byte.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(byte);
  }
  return out;
}

/** The WinAnsi positions that differ from Latin-1, the euro among them. */
const WIN_ANSI: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  ƒ: 0x83,
  '„': 0x84,
  '…': 0x85,
  '†': 0x86,
  '‡': 0x87,
  ˆ: 0x88,
  '‰': 0x89,
  Š: 0x8a,
  '‹': 0x8b,
  Œ: 0x8c,
  Ž: 0x8e,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '˜': 0x98,
  '™': 0x99,
  š: 0x9a,
  '›': 0x9b,
  œ: 0x9c,
  ž: 0x9e,
  Ÿ: 0x9f,
};

/**
 * Build the file: the objects, then the cross-reference table.
 *
 * Byte offsets are counted as the string grows, so the xref is right by
 * construction rather than by a second pass that could disagree with it.
 */
function assemble(contents: readonly string[], title: string): Uint8Array {
  const pageIds = contents.map((_, index) => 5 + index * 2);
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${contents.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>',
  ];

  contents.forEach((content, index) => {
    const streamId = (pageIds[index] ?? 5) + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamId} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  let file = `%PDF-1.4\n% ${escapeText(title)}\n`;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(file.length);
    file += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = file.length;
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) file += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return latin1Bytes(file);
}

/** Every character was already reduced to one byte by `escapeText`. */
function latin1Bytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

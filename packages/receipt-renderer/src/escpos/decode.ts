import { decodeCp858 } from './codepage.ts';
import { ESC, GS, LF } from './commands.ts';

/**
 * Replay an ESC/POS byte stream.
 *
 * This is how phase 1.5a is verified without a printer: the emitter's output is
 * decoded back into rows and compared against the layout. It also renders to SVG
 * so a human can look at a ticket on a Mac. It understands only the commands the
 * emitter produces - anything else is recorded as `unknownCommands` rather than
 * being silently skipped, so a future command cannot slip past unnoticed.
 */

export interface DecodedRow {
  text: string;
  bold: boolean;
  widthMultiplier: number;
  heightMultiplier: number;
}

export interface DecodedTicket {
  rows: DecodedRow[];
  /** Index into `rows` after which a cut happens. */
  cutAfterRow: number[];
  codePage?: number;
  initialised: boolean;
  unknownCommands: string[];
}

export function decodeEscPos(bytes: Uint8Array): DecodedTicket {
  const rows: DecodedRow[] = [];
  const cutAfterRow: number[] = [];
  const unknownCommands: string[] = [];

  let initialised = false;
  let codePage: number | undefined;
  let bold = false;
  let widthMultiplier = 1;
  let heightMultiplier = 1;
  let pending: number[] = [];

  const flush = (): void => {
    rows.push({
      text: decodeCp858(new Uint8Array(pending)),
      bold,
      widthMultiplier,
      heightMultiplier,
    });
    pending = [];
  };

  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index] ?? 0;

    if (byte === LF) {
      flush();
      index += 1;
      continue;
    }

    if (byte === ESC) {
      const command = bytes[index + 1];
      const argument = bytes[index + 2] ?? 0;
      switch (command) {
        case 0x40: // ESC @
          initialised = true;
          bold = false;
          widthMultiplier = 1;
          heightMultiplier = 1;
          index += 2;
          continue;
        case 0x74: // ESC t n
          codePage = argument;
          index += 3;
          continue;
        case 0x61: // ESC a n - the emitter pre-pads, so alignment is informational
          index += 3;
          continue;
        case 0x45: // ESC E n
          bold = argument !== 0;
          index += 3;
          continue;
        case 0x64: // ESC d n
          if (pending.length > 0) flush();
          for (let blank = 0; blank < argument; blank++) {
            rows.push({ text: '', bold: false, widthMultiplier: 1, heightMultiplier: 1 });
          }
          index += 3;
          continue;
        default:
          unknownCommands.push(`ESC 0x${(command ?? 0).toString(16)}`);
          index += 2;
          continue;
      }
    }

    if (byte === GS) {
      const command = bytes[index + 1];
      if (command === 0x21) {
        const packed = bytes[index + 2] ?? 0;
        widthMultiplier = ((packed >> 4) & 0x0f) + 1;
        heightMultiplier = (packed & 0x0f) + 1;
        index += 3;
        continue;
      }
      if (command === 0x56) {
        if (pending.length > 0) flush();
        cutAfterRow.push(rows.length - 1);
        index += 4; // GS V m n
        continue;
      }
      unknownCommands.push(`GS 0x${(command ?? 0).toString(16)}`);
      index += 2;
      continue;
    }

    pending.push(byte);
    index += 1;
  }

  if (pending.length > 0) flush();

  return {
    rows,
    cutAfterRow,
    ...(codePage === undefined ? {} : { codePage }),
    initialised,
    unknownCommands,
  };
}

/** Plain-text replay: what the paper will read, as text. */
export function decodeToText(bytes: Uint8Array): string {
  const ticket = decodeEscPos(bytes);
  const out: string[] = [];
  ticket.rows.forEach((row, rowIndex) => {
    out.push(row.text);
    if (ticket.cutAfterRow.includes(rowIndex)) out.push('%'.repeat(8) + ' CUT ' + '%'.repeat(8));
  });
  return out.join('\n');
}

/**
 * Cell geometry of the simulated character grid, in SVG user units. Arbitrary,
 * but fixed: `textLength` forces each row onto exactly this grid whatever the
 * viewer's monospace font actually measures.
 */
const CELL_WIDTH = 8;
const CELL_HEIGHT = 17;
const MARGIN = 12;

/**
 * Render the replay as SVG.
 *
 * SVG rather than PNG on purpose: it needs no embedded bitmap font, the text
 * stays selectable, and double-width/double-height rows can be shown at their
 * real proportions. Open it in any browser.
 *
 * Two details that are easy to get wrong and make the picture lie:
 *  - the rows are space-padded to the column count, so every text element needs
 *    explicit whitespace preservation or the viewer collapses the padding and
 *    `textLength` stretches the row to fill the gap;
 *  - `spacingAndGlyphs` (not `spacing`) is what actually scales a double-width
 *    row, and squeezing a double-height row back to single width is what makes
 *    it tall rather than merely bigger - which is what the printer does.
 */
export function decodeToSvg(bytes: Uint8Array, columns = 42): string {
  const ticket = decodeEscPos(bytes);
  const paperWidth = columns * CELL_WIDTH + MARGIN * 2;

  const parts: string[] = [];
  let y = MARGIN;

  ticket.rows.forEach((row, rowIndex) => {
    const rowHeight = CELL_HEIGHT * row.heightMultiplier;

    if (row.text !== '') {
      const width = row.text.length * CELL_WIDTH * row.widthMultiplier;
      // Baseline sits a little above the bottom of the cell.
      const baseline = y + rowHeight - CELL_HEIGHT * 0.25;
      parts.push(
        `<text x="${MARGIN}" y="${round(baseline)}"` +
          ` font-size="${round(CELL_HEIGHT * 0.76 * row.heightMultiplier)}"` +
          ` textLength="${round(width)}" lengthAdjust="spacingAndGlyphs"` +
          `${row.bold ? ' font-weight="700"' : ''}` +
          ` xml:space="preserve" style="white-space:pre"` +
          `>${escapeXml(row.text)}</text>`,
      );
    }
    y += rowHeight;

    if (ticket.cutAfterRow.includes(rowIndex)) {
      parts.push(
        `<line x1="0" y1="${round(y + CELL_HEIGHT / 2)}" x2="${round(paperWidth)}"` +
          ` y2="${round(y + CELL_HEIGHT / 2)}" stroke="#b0b0b0" stroke-dasharray="6 4"/>`,
      );
      y += CELL_HEIGHT;
    }
  });

  const height = round(y + MARGIN);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(paperWidth)}" height="${height}" ` +
    `viewBox="0 0 ${round(paperWidth)} ${height}">` +
    `<rect width="100%" height="100%" fill="#ffffff"/>` +
    `<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" ` +
    `fill="#111111">${parts.join('')}</g></svg>`
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

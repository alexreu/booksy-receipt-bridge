/**
 * Printer-independent description of a thermal ticket.
 *
 * This layer exists so the fiscal model never meets a printer command. It measures
 * everything in CHARACTER COLUMNS, not millimetres: a thermal printer has a fixed
 * character grid, so a layout that fits the grid cannot be clipped or rescaled.
 * That is what makes AC13 ("nothing important is cut") a pure assertion rather
 * than something you can only check on paper.
 */

export type Align = 'left' | 'center' | 'right';

export interface TicketStyle {
  bold?: boolean;
  /** Doubles glyph width, so it halves the columns available on that line. */
  doubleWidth?: boolean;
  doubleHeight?: boolean;
}

export type TicketLine =
  | { kind: 'text'; text: string; align?: Align; style?: TicketStyle }
  | { kind: 'two-col'; left: string; right: string; style?: TicketStyle }
  | { kind: 'separator'; char?: string }
  | { kind: 'feed'; lines: number }
  | { kind: 'cut' };

export interface TicketLayout {
  /** Character columns at single width. 42 for an 80 mm printer in Font A. */
  columns: number;
  lines: TicketLine[];
}

export interface TicketLayoutOptions {
  columns?: number;
  /**
   * Marks the ticket as a reprint. A reformatted NF525 receipt is a second
   * physical document, so a reprint says so rather than passing as the original.
   */
  duplicate?: boolean;
}

/** Columns usable on a line, accounting for double-width glyphs. */
export function effectiveColumns(columns: number, style?: TicketStyle): number {
  return style?.doubleWidth === true ? Math.floor(columns / 2) : columns;
}

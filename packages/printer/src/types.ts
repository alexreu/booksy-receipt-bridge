// Declared in @brb/shared so the extension's options page can be typed against
// it without pulling the renderer in through this package.
export type { Printer } from '@brb/shared';
import type { Printer } from '@brb/shared';

export interface PrinterConfig {
  /** Windows printer name, e.g. "EPSON TM-T88V Receipt5". Never hardcoded. */
  name: string;
  /** Physical paper width in mm. */
  paperWidth: number;
  /** Printable width in mm. */
  printableWidth: number;
  /** Character columns at single width. 42 for 80 mm Font A. */
  columns: number;
  /** Dots fed before the cut. */
  cutFeedDots?: number;
}

export const DEFAULT_PRINTER_CONFIG: Omit<PrinterConfig, 'name'> = {
  paperWidth: 80,
  printableWidth: 72,
  columns: 42,
  cutFeedDots: 0,
};

export interface PrintResult {
  ok: boolean;
  /** Spooler job id when the platform provides one. */
  jobId?: string;
  bytesSent?: number;
  /** Characters the code page could not represent, if any. */
  unmapped?: string[];
  error?: string;
}

/**
 * Printing boundary (plan section 36).
 *
 * Takes BYTES, not a Receipt: the printer layer has no business knowing what a
 * fiscal receipt is, and keeping it byte-level is what lets the whole pipeline be
 * exercised on a Mac with no printer attached. Composition with the fiscal model
 * happens one level up.
 */
export interface PrinterAdapter {
  list(): Promise<Printer[]>;
  printRaw(bytes: Uint8Array, config: PrinterConfig): Promise<PrintResult>;
  printTest(config: PrinterConfig): Promise<PrintResult>;
}

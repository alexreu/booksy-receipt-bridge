import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emitEscPos, decodeToSvg, decodeToText } from '@brb/receipt-renderer';
import { buildTestTicketLayout } from './test-ticket.ts';
import type { Printer, PrinterAdapter, PrinterConfig, PrintResult } from './types.ts';

export interface FilePrinterAdapterOptions {
  /** Directory the artefacts land in. */
  outDir: string;
  /** Base name. Required rather than defaulted to a timestamp: a hidden clock
   * would make the written filenames unpredictable, and these files are
   * compared in tests. */
  name: string;
}

/**
 * Writes what would have been printed to disk, in three forms:
 *   <name>.escpos.bin  the exact bytes, ready to copy to a Windows box
 *   <name>.txt         the replay as text
 *   <name>.svg         the replay as a picture
 *
 * This is how phase 1.5a is verified with no Windows machine and no printer: the
 * .bin is what the spike script sends to the spooler, and the .txt/.svg are what
 * a human checks in the meantime.
 */
export interface FilePrinter extends PrinterAdapter {
  /** Paths written, in order. */
  readonly written: readonly string[];
}

export function createFilePrinterAdapter(options: FilePrinterAdapterOptions): FilePrinter {
  const written: string[] = [];

  const list = (): Promise<Printer[]> =>
    Promise.resolve([{ name: `file:${options.outDir}`, isDefault: true, status: 'file sink' }]);

  const printRaw = async (bytes: Uint8Array, config: PrinterConfig): Promise<PrintResult> => {
    const base = options.name;
    await mkdir(options.outDir, { recursive: true });

    const binPath = join(options.outDir, `${base}.escpos.bin`);
    const textPath = join(options.outDir, `${base}.txt`);
    const svgPath = join(options.outDir, `${base}.svg`);

    await writeFile(binPath, bytes);
    await writeFile(textPath, `${decodeToText(bytes)}\n`, 'utf8');
    await writeFile(svgPath, decodeToSvg(bytes, config.columns), 'utf8');
    written.push(binPath, textPath, svgPath);

    return { ok: true, jobId: base, bytesSent: bytes.length };
  };

  const printTest = (config: PrinterConfig): Promise<PrintResult> => {
    const { bytes, unmapped } = emitEscPos(buildTestTicketLayout(config), {
      ...(config.cutFeedDots === undefined ? {} : { cutFeedDots: config.cutFeedDots }),
    });
    return printRaw(bytes, config).then((result) => ({ ...result, unmapped }));
  };

  return {
    list,
    printRaw,
    printTest,
    get written() {
      return written;
    },
  };
}

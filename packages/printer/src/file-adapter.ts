import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emitEscPos, decodeToSvg, decodeToText } from '@brb/receipt-renderer';
import { buildTestTicketLayout } from './test-ticket.ts';
import type { Printer, PrinterAdapter, PrinterConfig, PrintResult } from './types.ts';

export interface FilePrinterAdapterOptions {
  /** Directory the artefacts land in. */
  outDir: string;
  /** Base name; defaults to a timestamp. */
  name?: string;
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
export class FilePrinterAdapter implements PrinterAdapter {
  readonly written: string[] = [];

  constructor(private readonly options: FilePrinterAdapterOptions) {}

  list(): Promise<Printer[]> {
    return Promise.resolve([
      { name: `file:${this.options.outDir}`, isDefault: true, status: 'file sink' },
    ]);
  }

  async printRaw(bytes: Uint8Array, config: PrinterConfig): Promise<PrintResult> {
    const base = this.options.name ?? new Date().toISOString().replace(/[:.]/g, '-');
    await mkdir(this.options.outDir, { recursive: true });

    const binPath = join(this.options.outDir, `${base}.escpos.bin`);
    const textPath = join(this.options.outDir, `${base}.txt`);
    const svgPath = join(this.options.outDir, `${base}.svg`);

    await writeFile(binPath, bytes);
    await writeFile(textPath, `${decodeToText(bytes)}\n`, 'utf8');
    await writeFile(svgPath, decodeToSvg(bytes, config.columns), 'utf8');
    this.written.push(binPath, textPath, svgPath);

    return { ok: true, jobId: base, bytesSent: bytes.length };
  }

  printTest(config: PrinterConfig): Promise<PrintResult> {
    const { bytes, unmapped } = emitEscPos(buildTestTicketLayout(config), {
      ...(config.cutFeedDots === undefined ? {} : { cutFeedDots: config.cutFeedDots }),
    });
    return this.printRaw(bytes, config).then((result) => ({ ...result, unmapped }));
  }
}

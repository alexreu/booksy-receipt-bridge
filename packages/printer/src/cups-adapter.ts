import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Printer } from '@brb/shared';
import { emitEscPos } from '@brb/receipt-renderer';
import { buildTestTicketLayout } from './test-ticket.ts';
import type { PrinterAdapter, PrinterConfig, PrintResult } from './types.ts';

/**
 * Printing through CUPS - macOS, and Linux if it ever matters.
 *
 * WHY IT EXISTS. Windows is where this runs in production, but every printer
 * available for development is on a Mac. Without this the popup can only ever
 * offer mock queues here, and no end-to-end run on real hardware is possible.
 *
 * `-o raw` is the point, as `datatype RAW` is on Windows: the bytes reach the
 * device untouched, with no driver rendering and no page setup to rescale the
 * ticket. On a thermal printer that is the receipt. On a laser or an inkjet it
 * is control codes printed as text - a real job, really sent, that comes out as
 * gibberish. That is a property of ESC/POS, not of this adapter.
 *
 * PARSED WITHOUT READING PROSE. `lpstat -p` writes sentences in the system's
 * language ("l'imprimante X est inactive"), which is not something to parse.
 * `lpstat -e` lists destination names one per line in any locale, and the
 * default is found by looking for a name we already know inside `lpstat -d`
 * rather than by splitting its sentence.
 */

const EXEC_TIMEOUT_MS = 20_000;

export interface CupsAdapterOptions {
  /** Overridable so tests never shell out. */
  run?: (command: string, args: readonly string[]) => Promise<string>;
}

export function createCupsPrinterAdapter(options: CupsAdapterOptions = {}): PrinterAdapter {
  const run = options.run ?? execute;

  const list = async (): Promise<Printer[]> => {
    const names = parseDestinations(await run('lpstat', ['-e']).catch(() => ''));
    if (names.length === 0) return [];

    const fallback = defaultDestination(await run('lpstat', ['-d']).catch(() => ''), names);
    return names.map((name) => ({
      name,
      ...(name === fallback ? { isDefault: true } : {}),
    }));
  };

  const printRaw = async (bytes: Uint8Array, config: PrinterConfig): Promise<PrintResult> => {
    if (config.name === '') return { ok: false, error: 'Aucune imprimante configurée.' };

    // Through a file, like the Windows adapter: an ESC/POS stream is binary,
    // and no amount of shell quoting survives its control characters.
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'brb-print-'));
      const payload = join(directory, 'job.escpos.bin');
      await writeFile(payload, bytes);

      const output = await run('lp', [
        '-d',
        config.name,
        '-o',
        'raw',
        '-t',
        'Booksy receipt',
        payload,
      ]);
      const jobId = parseJobId(output);
      return { ok: true, bytesSent: bytes.length, ...(jobId === undefined ? {} : { jobId }) };
    } catch (error) {
      return { ok: false, error: describe(error) };
    } finally {
      if (directory !== undefined) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };

  const printTest = async (config: PrinterConfig): Promise<PrintResult> => {
    const { bytes, unmapped } = emitEscPos(buildTestTicketLayout(config), {
      ...(config.cutFeedDots === undefined ? {} : { cutFeedDots: config.cutFeedDots }),
    });
    const result = await printRaw(bytes, config);
    return { ...result, unmapped };
  };

  return { list, printRaw, printTest };
}

/** `lpstat -e`: one destination per line, no prose, any locale. */
export function parseDestinations(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * The default destination, found by name rather than by sentence.
 *
 * `lpstat -d` says "system default destination: X" in English and
 * "destination système par défaut : X" in French. Looking for a name we already
 * know inside that line works in both, and finds nothing when the machine has
 * no default at all - which is the honest answer.
 */
export function defaultDestination(output: string, known: readonly string[]): string | undefined {
  const tokens = new Set(output.split(/[\s:]+/).map((token) => token.trim()));
  return known.find((name) => tokens.has(name));
}

/** `lp` answers "request id is Canon_TR4600_series-42 (1 file(s))". */
export function parseJobId(output: string): string | undefined {
  return /(\S+-\d+)\s+\(/.exec(output)?.[1];
}

async function execute(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: EXEC_TIMEOUT_MS, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(stderr.trim() === '' ? error.message : stderr.trim()));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import type { Printer, PrinterAdapter, PrinterConfig, PrintResult } from './types.ts';
import { buildTestTicketLayout } from './test-ticket.ts';
import { emitEscPos } from '@brb/receipt-renderer';

export interface MockPrinterAdapterOptions {
  printers?: Printer[];
  /** Make every print fail with this message, to exercise error paths. */
  failWith?: string;
}

export interface MockPrintCall {
  bytes: Uint8Array;
  config: PrinterConfig;
}

export interface MockPrinter extends PrinterAdapter {
  /** What it was asked to print, in order. */
  readonly calls: readonly MockPrintCall[];
  readonly lastCall: MockPrintCall | undefined;
}

/**
 * In-memory adapter for tests and for the extension's E2E build.
 *
 * A factory over a closure rather than a class: there is no inheritance here to
 * justify one, the recorded calls stay private to it, and the returned object
 * is the interface and nothing more.
 */
export function createMockPrinterAdapter(
  options: MockPrinterAdapterOptions = {},
): MockPrinter {
  const calls: MockPrintCall[] = [];

  const list = (): Promise<Printer[]> =>
    Promise.resolve(
      options.printers ?? [{ name: 'Mock Thermal 80mm', isDefault: true, status: 'idle' }],
    );

  const printRaw = (bytes: Uint8Array, config: PrinterConfig): Promise<PrintResult> => {
    if (options.failWith !== undefined) {
      return Promise.resolve({ ok: false, error: options.failWith });
    }
    calls.push({ bytes, config });
    return Promise.resolve({ ok: true, jobId: `mock-${calls.length}`, bytesSent: bytes.length });
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
    get calls() {
      return calls;
    },
    get lastCall() {
      return calls[calls.length - 1];
    },
  };
}

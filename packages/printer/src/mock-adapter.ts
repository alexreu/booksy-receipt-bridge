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

/** In-memory adapter for tests and for the extension's E2E build. */
export class MockPrinterAdapter implements PrinterAdapter {
  readonly calls: MockPrintCall[] = [];

  constructor(private readonly options: MockPrinterAdapterOptions = {}) {}

  list(): Promise<Printer[]> {
    return Promise.resolve(
      this.options.printers ?? [
        { name: 'Mock Thermal 80mm', isDefault: true, status: 'idle' },
      ],
    );
  }

  printRaw(bytes: Uint8Array, config: PrinterConfig): Promise<PrintResult> {
    if (this.options.failWith !== undefined) {
      return Promise.resolve({ ok: false, error: this.options.failWith });
    }
    this.calls.push({ bytes, config });
    return Promise.resolve({
      ok: true,
      jobId: `mock-${this.calls.length}`,
      bytesSent: bytes.length,
    });
  }

  printTest(config: PrinterConfig): Promise<PrintResult> {
    const { bytes, unmapped } = emitEscPos(buildTestTicketLayout(config), {
      ...(config.cutFeedDots === undefined ? {} : { cutFeedDots: config.cutFeedDots }),
    });
    return this.printRaw(bytes, config).then((result) => ({ ...result, unmapped }));
  }
}

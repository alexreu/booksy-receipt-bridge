import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMockPrinterAdapter } from '@brb/printer';
import { decodeToText } from '@brb/receipt-renderer';
import { fixedClock } from '@brb/shared';
import { DEFAULT_CONFIG, type BridgeConfig } from '../config/config.ts';
import { silentLogger } from '../logging/logger.ts';
import { printReceipt, printTest, type PrintDeps } from './print.ts';

const PRINTER = 'EPSON TM-T88V Receipt5';
const FIXTURE = join(process.cwd(), 'fixtures/booksy/recu-1167.anon.pdf');

let downloads: string;
let receiptPath: string;
let historyPath: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'brb-print-'));
  downloads = join(root, 'Downloads');
  mkdirSync(downloads);
  receiptPath = join(downloads, 'recu-1167.pdf');
  copyFileSync(FIXTURE, receiptPath);
  historyPath = join(root, 'print-history.json');
});

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    printer: { ...DEFAULT_CONFIG.printer, name: PRINTER },
    update: DEFAULT_CONFIG.update,
    printing: { ...DEFAULT_CONFIG.printing, allowedDirs: [downloads] },
    ...overrides,
  };
}

function deps(overrides: Partial<PrintDeps> = {}): PrintDeps {
  return {
    printer: createMockPrinterAdapter(),
    config: config(),
    log: silentLogger(),
    historyPath,
    now: fixedClock(1_700_000_000_000),
    ...overrides,
  };
}

describe('printTest', () => {
  it('refuses when no printer is configured', async () => {
    const outcome = await printTest(
      deps({ config: config({ printer: { ...DEFAULT_CONFIG.printer, name: '' } }) }),
    );
    expect(outcome).toMatchObject({ ok: false, code: 'PRINTER_NOT_FOUND' });
  });

  it('sends the diagnostic ticket and reports the substituted characters', async () => {
    const printer = createMockPrinterAdapter();
    const outcome = await printTest(deps({ printer }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.bytesSent).toBeGreaterThan(0);
    expect(outcome.data.unmapped).toEqual(['’', 'œ']);
    expect(decodeToText(printer.calls[0]?.bytes ?? new Uint8Array())).toContain('1234567890');
  });

  it('reports a spooler failure as PRINT_FAILED', async () => {
    const printer = createMockPrinterAdapter({ failWith: 'imprimante hors ligne' });
    const outcome = await printTest(deps({ printer }));
    expect(outcome).toMatchObject({ ok: false, code: 'PRINT_FAILED' });
  });
});

describe('printReceipt - the happy path on a real receipt layout', () => {
  it('reads the PDF and prints the ticket', async () => {
    const printer = createMockPrinterAdapter();
    const outcome = await printReceipt(
      { source: { kind: 'path', path: receiptPath } },
      deps({ printer }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.ticketNumber).toBe('1167');
    expect(outcome.data.confidence).toBe(1);
    expect(outcome.data.warnings).toEqual([]);
    expect(outcome.data.duplicate).toBeUndefined();

    const printed = decodeToText(printer.calls[0]?.bytes ?? new Uint8Array());
    expect(printed).toContain('Ticket n° 1167');
    expect(printed).toContain('TOTAL TTC');
    expect(printed).toContain('300,00 €');
  });

  it('honours the configured column count', async () => {
    const printer = createMockPrinterAdapter();
    await printReceipt(
      { source: { kind: 'path', path: receiptPath } },
      deps({
        printer,
        config: config({ printer: { ...DEFAULT_CONFIG.printer, name: PRINTER, columns: 32 } }),
      }),
    );
    const rows = decodeToText(printer.calls[0]?.bytes ?? new Uint8Array()).split('\n');
    expect(rows.every((row) => row.length <= 32 || row.startsWith('%'))).toBe(true);
  });

  it('accepts the same receipt as bytes', async () => {
    const { readFileSync } = await import('node:fs');
    const base64 = readFileSync(receiptPath).toString('base64');
    const outcome = await printReceipt({ source: { kind: 'bytes', base64 } }, deps());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.data.ticketNumber).toBe('1167');
  });
});

describe('printReceipt - refusals happen before any byte reaches the spooler', () => {
  it('refuses with no printer configured', async () => {
    const printer = createMockPrinterAdapter();
    const outcome = await printReceipt(
      { source: { kind: 'path', path: receiptPath } },
      deps({ printer, config: config({ printer: { ...DEFAULT_CONFIG.printer, name: '' } }) }),
    );
    expect(outcome).toMatchObject({ ok: false, code: 'PRINTER_NOT_FOUND' });
    expect(printer.calls).toEqual([]);
  });

  it('refuses a file outside the allowed directories', async () => {
    const printer = createMockPrinterAdapter();
    const outcome = await printReceipt(
      { source: { kind: 'path', path: FIXTURE } },
      deps({ printer }),
    );
    expect(outcome).toMatchObject({ ok: false, code: 'FILE_NOT_ALLOWED' });
    expect(printer.calls).toEqual([]);
  });

  it('refuses a PDF that is not a Booksy receipt - AC17', async () => {
    const printer = createMockPrinterAdapter();
    const other = join(downloads, 'facture.pdf');
    writeFileSync(other, Buffer.from('%PDF-1.4\nFACTURE 2026-0042\n'));

    const outcome = await printReceipt({ source: { kind: 'path', path: other } }, deps({ printer }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(['NOT_BOOKSY', 'PARSING_FAILED']).toContain(outcome.code);
    expect(printer.calls).toEqual([]);
  });

  it('reports a spooler failure without claiming success', async () => {
    const printer = createMockPrinterAdapter({ failWith: 'bourrage papier' });
    const outcome = await printReceipt(
      { source: { kind: 'path', path: receiptPath } },
      deps({ printer }),
    );
    expect(outcome).toMatchObject({ ok: false, code: 'PRINT_FAILED' });
  });
});

describe('printReceipt - deduplication', () => {
  it('prints once for a double click', async () => {
    const printer = createMockPrinterAdapter();
    const shared = deps({ printer });

    const first = await printReceipt({ source: { kind: 'path', path: receiptPath } }, shared);
    const second = await printReceipt({ source: { kind: 'path', path: receiptPath } }, shared);

    expect(first.ok && first.data.duplicate).toBeUndefined();
    expect(second.ok && second.data.duplicate).toBe(true);
    // One ticket on paper, and the second call is a success, not an error: the
    // caller asked twice and got the intended outcome.
    expect(printer.calls).toHaveLength(1);
    expect(second.ok).toBe(true);
  });

  it('still reports the ticket and confidence on the suppressed call', async () => {
    const shared = deps();
    await printReceipt({ source: { kind: 'path', path: receiptPath } }, shared);
    const second = await printReceipt({ source: { kind: 'path', path: receiptPath } }, shared);
    expect(second.ok && second.data.ticketNumber).toBe('1167');
    expect(second.ok && second.data.confidence).toBe(1);
  });

  it('honours an explicit dedupe key from the caller', async () => {
    const printer = createMockPrinterAdapter();
    const shared = deps({ printer });
    await printReceipt(
      { source: { kind: 'path', path: receiptPath }, dedupeKey: 'download:42' },
      shared,
    );
    const second = await printReceipt(
      { source: { kind: 'path', path: receiptPath }, dedupeKey: 'download:42' },
      shared,
    );
    expect(second.ok && second.data.duplicate).toBe(true);
    expect(printer.calls).toHaveLength(1);
  });
});

describe('printReceipt - the confidence threshold', () => {
  it('lets a user print whatever was read, and reports the confidence', async () => {
    const printer = createMockPrinterAdapter();
    const outcome = await printReceipt(
      { source: { kind: 'path', path: receiptPath }, trigger: 'user' },
      deps({
        printer,
        config: config({
          printing: { ...DEFAULT_CONFIG.printing, allowedDirs: [downloads], confidenceThreshold: 1 },
        }),
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(printer.calls).toHaveLength(1);
  });

  it('allows an automatic print that exactly meets the threshold', async () => {
    // Plan section 34. The rule lives here because the host owns the config.
    const printer = createMockPrinterAdapter();
    const outcome = await printReceipt(
      { source: { kind: 'path', path: receiptPath }, trigger: 'auto' },
      deps({
        printer,
        config: config({
          printing: {
            ...DEFAULT_CONFIG.printing,
            allowedDirs: [downloads],
            // The fixture parses at 1.0, so nothing can clear a threshold above it.
            confidenceThreshold: 1,
          },
        }),
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(printer.calls).toHaveLength(1);
  });

  it('refuses an automatic print when the reading is too uncertain', async () => {
    const printer = createMockPrinterAdapter();
    const partial = join(downloads, 'partiel.pdf');
    // A Booksy-shaped document with no VAT table and no certification: it is
    // recognisable, but not confidently readable.
    const { makeSyntheticPdf } = await import('@brb/pdf-inspector/testing');
    writeFileSync(
      partial,
      makeSyntheticPdf([
        [
          { text: 'Ticket n 51', x: 60, y: 780 },
          { text: "Type d'operation: Vente", x: 60, y: 760 },
          { text: 'Nom de la prestation ou du produit', x: 60, y: 700 },
          { text: 'Coupe', x: 60, y: 680 },
          { text: '30,00 \u20ac', x: 400, y: 680 },
          { text: 'Total TTC', x: 60, y: 640 },
          { text: '30,00 \u20ac', x: 400, y: 640 },
        ],
      ]),
    );

    const outcome = await printReceipt(
      { source: { kind: 'path', path: partial }, trigger: 'auto' },
      deps({ printer }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('INVALID_RECEIPT');
    expect(outcome.message).toContain('automatique');
    expect(printer.calls).toEqual([]);
  });
});

describe('printReceipt - warnings pass straight through', () => {
  it('prints the total the document states and reports the disagreement', async () => {
    // Section 31: the bridge never corrects a fiscal value. Here the items sum
    // to 30 while the document claims 999, and 999 is what goes on the paper.
    const { makeSyntheticPdf } = await import('@brb/pdf-inspector/testing');
    const inconsistent = join(downloads, 'incoherent.pdf');
    writeFileSync(
      inconsistent,
      makeSyntheticPdf([
        [
          { text: 'Ticket n 77', x: 60, y: 780 },
          { text: "Type d'operation: Vente", x: 60, y: 765 },
          { text: 'SIRET: 00000000000000', x: 60, y: 735 },
          { text: 'Nom de la prestation ou du produit', x: 60, y: 700 },
          { text: 'Coupe', x: 60, y: 680 },
          { text: 'T2000', x: 300, y: 680 },
          { text: '30,00 \u20ac', x: 400, y: 680 },
          { text: 'Total TTC', x: 60, y: 640 },
          { text: '999,00 \u20ac', x: 400, y: 640 },
          { text: 'Code TVA', x: 60, y: 600 },
          { text: 'Taux de TVA', x: 150, y: 600 },
          { text: 'T2000', x: 60, y: 585 },
          { text: '20%', x: 150, y: 585 },
          { text: '5,00 \u20ac', x: 260, y: 585 },
          { text: '25,00 \u20ac', x: 360, y: 585 },
          { text: '(NF525)_B_0000-0_XxxX', x: 60, y: 540 },
        ],
      ]),
    );

    const printer = createMockPrinterAdapter();
    const outcome = await printReceipt(
      { source: { kind: 'path', path: inconsistent } },
      deps({ printer }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.warnings.map((warning) => warning.code)).toContain('ITEMS_SUM_MISMATCH');

    const printed = decodeToText(printer.calls[0]?.bytes ?? new Uint8Array());
    expect(printed).toContain('999,00 \u20ac');
    expect(printed).not.toContain('TOTAL TTC                          30,00');
  });
});

describe('printReceipt - a failed job is not a printed one', () => {
  it('lets the next click through after a failure', async () => {
    // Reported from a till: the first attempt failed, and every click for the
    // next two minutes answered "already printed, nothing sent" - about a
    // ticket that had never come out of the printer.
    const failed = await printReceipt(
      { source: { kind: 'path', path: receiptPath } },
      deps({ printer: createMockPrinterAdapter({ failWith: 'imprimante hors ligne' }) }),
    );
    expect(failed).toMatchObject({ ok: false, code: 'PRINT_FAILED' });

    const printer = createMockPrinterAdapter();
    const retried = await printReceipt(
      { source: { kind: 'path', path: receiptPath } },
      deps({ printer }),
    );

    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.data.duplicate).toBeUndefined();
    expect(printer.calls).toHaveLength(1);
  });

  it('still refuses a second print after a successful one', async () => {
    // The protection itself has to survive the fix.
    const printer = createMockPrinterAdapter();
    await printReceipt({ source: { kind: 'path', path: receiptPath } }, deps({ printer }));
    const again = await printReceipt(
      { source: { kind: 'path', path: receiptPath } },
      deps({ printer }),
    );

    expect(again).toMatchObject({ ok: true, data: { duplicate: true } });
    expect(printer.calls).toHaveLength(1);
  });
});

describe('printReceipt - the driver lays the ticket out', () => {
  /** A driver that renders text, and records what it was given. */
  function textAdapter(withText: boolean) {
    const texts: string[] = [];
    const raws: number[] = [];
    const base = {
      list: () => Promise.resolve([{ name: PRINTER }]),
      printRaw: (bytes: Uint8Array) => {
        raws.push(bytes.length);
        return Promise.resolve({ ok: true, bytesSent: bytes.length });
      },
      printTest: () => Promise.resolve({ ok: true }),
    };
    const adapter = withText
      ? {
          ...base,
          printText: (text: string) => {
            texts.push(text);
            return Promise.resolve({ ok: true, bytesSent: text.length });
          },
        }
      : base;
    return { adapter, texts, raws };
  }

  it('sends the ticket as text, never as ESC/POS', async () => {
    // The fallback for a driver that accepts raw ESC/POS, reports it written,
    // and prints nothing - which is what a TM-T88V did behind EPSON's APD.
    const { adapter, texts, raws } = textAdapter(true);
    const outcome = await printReceipt(
      { source: { kind: 'path', path: receiptPath } },
      deps({
        printer: adapter,
        config: config({ printer: { ...DEFAULT_CONFIG.printer, name: PRINTER, kind: 'text' } }),
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(raws).toEqual([]);
    expect(texts).toHaveLength(1);
    // The same grid as the thermal route: 42 columns, the same amounts.
    expect(texts[0]).toContain('TOTAL TTC');
    expect(texts[0]?.split('\n')[0]?.length).toBeLessThanOrEqual(42);
  });

  it('says so, and forgets the job, when the driver cannot render text', async () => {
    const { adapter } = textAdapter(false);
    const outcome = await printReceipt(
      { source: { kind: 'path', path: receiptPath } },
      deps({
        printer: adapter,
        config: config({ printer: { ...DEFAULT_CONFIG.printer, name: PRINTER, kind: 'text' } }),
      }),
    );

    expect(outcome).toMatchObject({ ok: false, code: 'PRINT_FAILED' });

    // And the next attempt is allowed through, since nothing printed.
    const { adapter: second, texts } = textAdapter(true);
    const retried = await printReceipt(
      { source: { kind: 'path', path: receiptPath } },
      deps({
        printer: second,
        config: config({ printer: { ...DEFAULT_CONFIG.printer, name: PRINTER, kind: 'text' } }),
      }),
    );
    expect(retried.ok).toBe(true);
    expect(texts).toHaveLength(1);
  });
});

describe('printReceipt - an ordinary printer', () => {
  /** A driver that records what it was handed, and how. */
  function recordingAdapter(withDocument: boolean) {
    const sent: { how: 'raw' | 'document'; bytes: Uint8Array }[] = [];
    const base = {
      list: () => Promise.resolve([{ name: PRINTER }]),
      printRaw: (bytes: Uint8Array) => {
        sent.push({ how: 'raw' as const, bytes });
        return Promise.resolve({ ok: true, bytesSent: bytes.length });
      },
      printTest: () => Promise.resolve({ ok: true }),
    };
    const adapter = withDocument
      ? {
          ...base,
          printDocument: (bytes: Uint8Array) => {
            sent.push({ how: 'document' as const, bytes });
            return Promise.resolve({ ok: true, bytesSent: bytes.length });
          },
        }
      : base;
    return { adapter, sent };
  }

  it('sends a rendered PDF, never ESC/POS, when the printer is not thermal', async () => {
    // Control codes reach a laser as text and come out as gibberish. The
    // layout is the same; only what carries it changes.
    const { adapter, sent } = recordingAdapter(true);
    const outcome = await printReceipt(
      { source: { kind: 'path', path: receiptPath } },
      deps({
        printer: adapter,
        config: config({ printer: { ...DEFAULT_CONFIG.printer, name: PRINTER, kind: 'paper' } }),
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(sent.map((job) => job.how)).toEqual(['document']);
    const header = Array.from((sent[0]?.bytes ?? new Uint8Array()).slice(0, 8), (byte) =>
      String.fromCharCode(byte),
    ).join('');
    expect(header).toBe('%PDF-1.4');
  });

  it('sends ESC/POS when the printer is thermal', async () => {
    const { adapter, sent } = recordingAdapter(true);
    const outcome = await printReceipt(
      { source: { kind: 'path', path: receiptPath } },
      deps({ printer: adapter }),
    );

    expect(outcome.ok).toBe(true);
    expect(sent.map((job) => job.how)).toEqual(['raw']);
    expect(sent[0]?.bytes[0]).toBe(0x1b);
  });

  it('says so rather than printing gibberish when the driver cannot render', async () => {
    // A spooler that only speaks RAW says so by not implementing the method;
    // falling back to ESC/POS would waste a sheet to prove a point.
    const { adapter, sent } = recordingAdapter(false);
    const outcome = await printReceipt(
      { source: { kind: 'path', path: receiptPath } },
      deps({
        printer: adapter,
        config: config({ printer: { ...DEFAULT_CONFIG.printer, name: PRINTER, kind: 'paper' } }),
      }),
    );

    expect(outcome).toMatchObject({ ok: false, code: 'PRINT_FAILED' });
    expect(sent).toEqual([]);
  });
});

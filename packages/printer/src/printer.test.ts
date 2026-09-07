import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeEscPos, decodeToText } from '@brb/receipt-renderer';
import { layoutToLines } from '@brb/ticket-layout';
import { FilePrinterAdapter } from './file-adapter.ts';
import { MockPrinterAdapter } from './mock-adapter.ts';
import { buildTestTicketLayout } from './test-ticket.ts';
import { DEFAULT_PRINTER_CONFIG, type PrinterConfig } from './types.ts';

const CONFIG: PrinterConfig = { name: 'EPSON TM-T88V Receipt5', ...DEFAULT_PRINTER_CONFIG };

describe('DEFAULT_PRINTER_CONFIG', () => {
  it('describes 80 mm paper with a 72 mm printable width', () => {
    expect(DEFAULT_PRINTER_CONFIG.paperWidth).toBe(80);
    expect(DEFAULT_PRINTER_CONFIG.printableWidth).toBe(72);
    expect(DEFAULT_PRINTER_CONFIG.columns).toBe(42);
  });

  it('carries no printer name, so nothing is hardcoded to one device', () => {
    expect(DEFAULT_PRINTER_CONFIG).not.toHaveProperty('name');
  });
});

describe('buildTestTicketLayout', () => {
  it('prints a column ruler that ends exactly at the last column', () => {
    const lines = layoutToLines(buildTestTicketLayout(CONFIG));
    const ruler = lines.find((line) => line.startsWith('1234567890'));
    expect(ruler).toHaveLength(42);
    expect(ruler?.endsWith('12')).toBe(true);
  });

  it('adapts the ruler to a different column count', () => {
    const lines = layoutToLines(buildTestTicketLayout({ ...CONFIG, columns: 56 }));
    expect(lines.find((line) => line.startsWith('1234567890'))).toHaveLength(56);
  });

  it('names the configured printer rather than a hardcoded model', () => {
    const text = layoutToLines(buildTestTicketLayout({ ...CONFIG, name: 'Autre' })).join('\n');
    expect(text).toContain('Autre');
    expect(text).not.toContain('TM-T88V');
  });

  it('exercises the characters and styles the real ticket needs', () => {
    const layout = buildTestTicketLayout(CONFIG);
    const text = layoutToLines(layout).join('\n');
    expect(text).toContain('€');
    expect(text).toContain('é');
    expect(text).toContain('°');
    expect(layout.lines).toContainEqual({
      kind: 'text',
      text: 'Double largeur',
      style: { doubleWidth: true },
    });
  });

  it('fits the grid', () => {
    for (const columns of [32, 42, 56]) {
      const lines = layoutToLines(buildTestTicketLayout({ ...CONFIG, columns }));
      expect(lines.filter((line) => line.length > columns)).toEqual([]);
    }
  });
});

describe('MockPrinterAdapter', () => {
  it('lists a default printer', async () => {
    const printers = await new MockPrinterAdapter().list();
    expect(printers[0]?.isDefault).toBe(true);
  });

  it('lists the printers it was given', async () => {
    const adapter = new MockPrinterAdapter({ printers: [{ name: 'A' }, { name: 'B' }] });
    expect((await adapter.list()).map((printer) => printer.name)).toEqual(['A', 'B']);
  });

  it('records what it was asked to print', async () => {
    const adapter = new MockPrinterAdapter();
    const result = await adapter.printRaw(new Uint8Array([1, 2, 3]), CONFIG);
    expect(result).toMatchObject({ ok: true, bytesSent: 3 });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.config.name).toBe('EPSON TM-T88V Receipt5');
  });

  it('prints a valid test ticket', async () => {
    const adapter = new MockPrinterAdapter();
    const result = await adapter.printTest(CONFIG);
    expect(result.ok).toBe(true);
    const decoded = decodeEscPos(adapter.calls[0]?.bytes ?? new Uint8Array());
    expect(decoded.codePage).toBe(19);
    expect(decoded.unknownCommands).toEqual([]);
    expect(decodeToText(adapter.calls[0]?.bytes ?? new Uint8Array())).toContain('1234567890');
  });

  it('reports the substituted characters of the test ticket', async () => {
    // The test ticket deliberately carries characters CP858 lacks - a
    // typographic apostrophe and an oe ligature - so that printing it tells you
    // which glyphs get substituted on this printer before a real receipt does.
    const result = await new MockPrinterAdapter().printTest(CONFIG);
    expect(result.unmapped).toEqual(['’', 'œ']);
  });

  it('fails when told to, without recording the call', async () => {
    const adapter = new MockPrinterAdapter({ failWith: 'PRINTER_OFFLINE' });
    const result = await adapter.printRaw(new Uint8Array([1]), CONFIG);
    expect(result).toEqual({ ok: false, error: 'PRINTER_OFFLINE' });
    expect(adapter.calls).toEqual([]);
  });

  it('honours the cut feed from the config', async () => {
    const adapter = new MockPrinterAdapter();
    await adapter.printTest({ ...CONFIG, cutFeedDots: 30 });
    const bytes = adapter.calls[0]?.bytes ?? new Uint8Array();
    expect([...bytes.slice(-4)]).toEqual([0x1d, 0x56, 66, 30]);
  });
});

describe('FilePrinterAdapter', () => {
  it('writes the bytes, the text replay and the picture', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'brb-print-'));
    const adapter = new FilePrinterAdapter({ outDir, name: 'ticket' });

    const result = await adapter.printTest(CONFIG);
    expect(result.ok).toBe(true);

    const files = (await readdir(outDir)).sort();
    expect(files).toEqual(['ticket.escpos.bin', 'ticket.svg', 'ticket.txt']);

    const bin = await readFile(join(outDir, 'ticket.escpos.bin'));
    expect(result.bytesSent).toBe(bin.length);
    expect([...bin.subarray(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x74, 19]);

    const text = await readFile(join(outDir, 'ticket.txt'), 'utf8');
    expect(text).toContain('BOOKSY RECEIPT BRIDGE');
    expect(text).toContain('CUT');

    const svg = await readFile(join(outDir, 'ticket.svg'), 'utf8');
    expect(svg.startsWith('<svg')).toBe(true);
  });

  it('creates the output directory if it does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'brb-print-'));
    const outDir = join(root, 'nested', 'deeper');
    const adapter = new FilePrinterAdapter({ outDir, name: 't' });
    await adapter.printRaw(new Uint8Array([0x41, 0x0a]), CONFIG);
    expect(await readdir(outDir)).toContain('t.escpos.bin');
  });

  it('describes itself as a file sink rather than pretending to be a printer', async () => {
    const printers = await new FilePrinterAdapter({ outDir: '/tmp' }).list();
    expect(printers[0]?.name).toContain('file:');
  });
});

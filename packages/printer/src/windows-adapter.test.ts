import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { decodeToText } from '@brb/receipt-renderer';
import { WindowsPrinterAdapter, parsePrinterList, type RunPowerShell } from './windows-adapter.ts';
import { DEFAULT_PRINTER_CONFIG, type PrinterConfig } from './types.ts';

const CONFIG: PrinterConfig = { name: 'EPSON TM-T88V Receipt5', ...DEFAULT_PRINTER_CONFIG };

function adapterWith(run: RunPowerShell): WindowsPrinterAdapter {
  return new WindowsPrinterAdapter({ run });
}

describe('parsePrinterList', () => {
  it('reads the array PowerShell emits for several printers', () => {
    const output = JSON.stringify([
      { Name: 'EPSON TM-T88V Receipt5', PrinterStatus: 3, IsDefault: true },
      { Name: 'Microsoft Print to PDF', PrinterStatus: 3, IsDefault: false },
    ]);
    expect(parsePrinterList(output)).toEqual([
      { name: 'EPSON TM-T88V Receipt5', isDefault: true, status: '3' },
      { name: 'Microsoft Print to PDF', status: '3' },
    ]);
  });

  it('reads the bare object PowerShell emits for a single printer', () => {
    // ConvertTo-Json collapses a one-element result to an object, which is the
    // classic way a printer list comes back empty in production.
    const output = JSON.stringify({ Name: 'Seule', PrinterStatus: 3, IsDefault: true });
    expect(parsePrinterList(output)).toEqual([{ name: 'Seule', isDefault: true, status: '3' }]);
  });

  it('returns nothing for a machine with no printers', () => {
    expect(parsePrinterList('')).toEqual([]);
    expect(parsePrinterList('   \n')).toEqual([]);
  });

  it('returns nothing rather than throwing on unparseable output', () => {
    expect(parsePrinterList('At line:1 char:1 + Get-Printer')).toEqual([]);
  });

  it('skips rows with no usable name', () => {
    const output = JSON.stringify([{ Name: '' }, { Name: 42 }, null, { Name: 'Bonne' }]);
    expect(parsePrinterList(output)).toEqual([{ name: 'Bonne' }]);
  });
});

describe('WindowsPrinterAdapter.list', () => {
  it('asks PowerShell for the queues and the default', async () => {
    const run = vi.fn<RunPowerShell>().mockResolvedValue(JSON.stringify({ Name: 'X' }));
    const printers = await adapterWith(run).list();
    expect(printers).toEqual([{ name: 'X' }]);

    const script = run.mock.calls[0]?.[0] ?? '';
    expect(script).toContain('Get-Printer');
    expect(script).toContain('Win32_Printer');
    expect(script).toContain('ConvertTo-Json');
  });
});

describe('WindowsPrinterAdapter.printRaw', () => {
  it('refuses with no printer name rather than sending to nothing', async () => {
    const run = vi.fn<RunPowerShell>();
    const result = await adapterWith(run).printRaw(new Uint8Array([1]), { ...CONFIG, name: '' });
    expect(result.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('sends the bytes as a RAW spooler job', async () => {
    // RAW is the whole point: it bypasses the driver's rendering and page
    // setup, so nothing rescales the ticket and no dialog appears.
    const run = vi.fn<RunPowerShell>().mockResolvedValue('written=42\n');
    const result = await adapterWith(run).printRaw(new Uint8Array([1, 2, 3]), CONFIG);

    expect(result).toMatchObject({ ok: true, bytesSent: 42 });
    const script = run.mock.calls[0]?.[0] ?? '';
    expect(script).toContain('pDataType = "RAW"');
    expect(script).toContain('WritePrinter');
    expect(script).toContain("'EPSON TM-T88V Receipt5'");
  });

  it('passes the bytes through a file, not the command line', async () => {
    // An ESC/POS stream is binary and full of control characters; no amount of
    // shell quoting survives it.
    const run = vi.fn<RunPowerShell>().mockResolvedValue('written=3');
    await adapterWith(run).printRaw(new Uint8Array([0x1b, 0x40, 0x0a]), CONFIG);
    const script = run.mock.calls[0]?.[0] ?? '';
    expect(script).toContain('ReadAllBytes');
    expect(script).toContain('.escpos.bin');
  });

  it('escapes a printer name containing a quote', async () => {
    const run = vi.fn<RunPowerShell>().mockResolvedValue('written=1');
    await adapterWith(run).printRaw(new Uint8Array([1]), { ...CONFIG, name: "L'imprimante" });
    expect(run.mock.calls[0]?.[0]).toContain("'L''imprimante'");
  });

  it('falls back to the payload length when the output says nothing', async () => {
    const run = vi.fn<RunPowerShell>().mockResolvedValue('');
    const result = await adapterWith(run).printRaw(new Uint8Array([1, 2, 3, 4]), CONFIG);
    expect(result).toMatchObject({ ok: true, bytesSent: 4 });
  });

  it('reports a PowerShell failure instead of throwing', async () => {
    const run = vi
      .fn<RunPowerShell>()
      .mockRejectedValue(new Error('OpenPrinter failed, Win32 error 1801'));
    const result = await adapterWith(run).printRaw(new Uint8Array([1]), CONFIG);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('1801');
  });
});

describe('WindowsPrinterAdapter.printTest', () => {
  it('sends the diagnostic ticket and reports substituted characters', async () => {
    let sent: Uint8Array | undefined;
    const run = vi.fn<RunPowerShell>().mockImplementation((script) => {
      // Recover the payload the adapter wrote, to prove it is a real ticket.
      const path = /ReadAllBytes\('([^']+)'\)/.exec(script)?.[1];
      if (path !== undefined) {
        sent = new Uint8Array(readFileSync(path));
      }
      return Promise.resolve('written=1');
    });

    const result = await adapterWith(run).printTest(CONFIG);
    expect(result.ok).toBe(true);
    expect(result.unmapped).toEqual(['’', 'œ']);
    expect(decodeToText(sent ?? new Uint8Array())).toContain('1234567890');
  });
});

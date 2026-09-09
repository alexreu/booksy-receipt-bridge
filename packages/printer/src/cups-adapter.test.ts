import { describe, expect, it } from 'vitest';
import {
  createCupsPrinterAdapter,
  defaultDestination,
  parseDestinations,
  parseJobId,
} from './cups-adapter.ts';
import { DEFAULT_PRINTER_CONFIG } from './types.ts';

const CONFIG = { ...DEFAULT_PRINTER_CONFIG, name: 'Canon_TR4600_series' };

/** Records what would have been run, and answers with canned output. */
function fakeShell(replies: Record<string, string> = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const run = (command: string, args: readonly string[]): Promise<string> => {
    calls.push({ command, args: [...args] });
    return Promise.resolve(replies[command] ?? '');
  };
  return { calls, run };
}

describe('parseDestinations', () => {
  it('reads one destination per line, whatever the language', () => {
    // `lpstat -e` prints names only - the reason it is used instead of -p,
    // whose output is a sentence in the system's language.
    expect(parseDestinations('Canon_TR4600_series\nEPSON_TM_T88V\n')).toEqual([
      'Canon_TR4600_series',
      'EPSON_TM_T88V',
    ]);
  });

  it('reads a machine with no printer as an empty list', () => {
    expect(parseDestinations('')).toEqual([]);
    expect(parseDestinations('\n  \n')).toEqual([]);
  });
});

describe('defaultDestination', () => {
  it('finds the default in French', () => {
    const output = 'destination système par défaut : Canon_TR4600_series';
    expect(defaultDestination(output, ['Canon_TR4600_series', 'EPSON'])).toBe(
      'Canon_TR4600_series',
    );
  });

  it('finds the default in English', () => {
    const output = 'system default destination: EPSON_TM_T88V';
    expect(defaultDestination(output, ['Canon_TR4600_series', 'EPSON_TM_T88V'])).toBe(
      'EPSON_TM_T88V',
    );
  });

  it('finds none when the machine has no default', () => {
    // "no system default destination" names nothing, in any language.
    expect(defaultDestination('no system default destination', ['EPSON'])).toBeUndefined();
  });
});

describe('parseJobId', () => {
  it('reads the id lp reports', () => {
    expect(parseJobId('request id is Canon_TR4600_series-42 (1 file(s))')).toBe(
      'Canon_TR4600_series-42',
    );
  });

  it('reads nothing rather than guessing', () => {
    expect(parseJobId('')).toBeUndefined();
  });
});

describe('createCupsPrinterAdapter', () => {
  it('lists the queues the machine really has, marking the default', async () => {
    // Both lpstat calls answer the same canned text here: the default is the
    // known name found inside it, which is what the real -d output amounts to.
    const shell = fakeShell({ lpstat: 'Canon_TR4600_series\nEPSON_TM_T88V\n' });
    const adapter = createCupsPrinterAdapter({ run: shell.run });

    expect(await adapter.list()).toEqual([
      { name: 'Canon_TR4600_series', isDefault: true },
      { name: 'EPSON_TM_T88V' },
    ]);
  });

  it('sends the bytes raw, so no driver rescales the ticket', async () => {
    const shell = fakeShell({ lp: 'request id is Canon_TR4600_series-7 (1 file(s))' });
    const adapter = createCupsPrinterAdapter({ run: shell.run });

    const result = await adapter.printRaw(new Uint8Array([0x1b, 0x40, 0x41]), CONFIG);

    expect(result).toMatchObject({ ok: true, bytesSent: 3, jobId: 'Canon_TR4600_series-7' });
    const lp = shell.calls.find((call) => call.command === 'lp');
    expect(lp?.args.slice(0, 4)).toEqual(['-d', 'Canon_TR4600_series', '-o', 'raw']);
  });

  it('refuses to print with no printer chosen, rather than to the default', async () => {
    const shell = fakeShell();
    const adapter = createCupsPrinterAdapter({ run: shell.run });

    const result = await adapter.printRaw(new Uint8Array([1]), { ...CONFIG, name: '' });

    expect(result.ok).toBe(false);
    expect(shell.calls).toEqual([]);
  });

  it('reports what the command said when it failed', async () => {
    const adapter = createCupsPrinterAdapter({
      run: () => Promise.reject(new Error('lp: Destination "X" introuvable')),
    });

    const result = await adapter.printRaw(new Uint8Array([1]), CONFIG);

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('introuvable');
  });
});

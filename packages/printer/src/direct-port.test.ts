import { describe, expect, it } from 'vitest';
import { createMockPrinterAdapter } from './mock-adapter.ts';
import { parsePortTarget, withDirectPorts, type PortTarget } from './direct-port.ts';
import { DEFAULT_PRINTER_CONFIG } from './types.ts';

const TICKET = new Uint8Array([0x1b, 0x40, 0x41]);

function configFor(name: string) {
  return { ...DEFAULT_PRINTER_CONFIG, name };
}

/** Records what would have been written, and where. */
function recorder(fail?: string) {
  const writes: { target: PortTarget; bytes: Uint8Array }[] = [];
  const write = (target: PortTarget, bytes: Uint8Array): Promise<void> => {
    if (fail !== undefined) return Promise.reject(new Error(fail));
    writes.push({ target, bytes });
    return Promise.resolve();
  };
  return { writes, write };
}

describe('parsePortTarget', () => {
  it('reads a serial or parallel port, in the namespace Windows needs', () => {
    // \\.\ is required beyond COM9 and accepted for all of them, so it is
    // always used rather than only sometimes.
    expect(parsePortTarget('COM3')).toEqual({ kind: 'device', path: '\\\\.\\COM3' });
    expect(parsePortTarget('com12:')).toEqual({ kind: 'device', path: '\\\\.\\COM12' });
    expect(parsePortTarget('LPT1')).toEqual({ kind: 'device', path: '\\\\.\\LPT1' });
  });

  it('reads a network printer', () => {
    expect(parsePortTarget('192.168.1.50:9100')).toEqual({
      kind: 'tcp',
      host: '192.168.1.50',
      port: 9100,
    });
    expect(parsePortTarget('tcp://caisse.local:9100')).toEqual({
      kind: 'tcp',
      host: 'caisse.local',
      port: 9100,
    });
  });

  it('reads a queue name as a queue name', () => {
    // Deliberately narrow: printing to the wrong place is worse than not
    // printing, and a queue can be called almost anything.
    for (const name of [
      'EPSON TM-T88V Receipt5',
      'Mock Thermal 80mm',
      'Canon_TR4600_series',
      'COMPTOIR',
      '',
    ]) {
      expect(parsePortTarget(name), name).toBeUndefined();
    }
  });

  it('refuses a port number that cannot exist', () => {
    expect(parsePortTarget('192.168.1.50:70000')).toBeUndefined();
    expect(parsePortTarget('192.168.1.50:0')).toBeUndefined();
  });
});

describe('withDirectPorts', () => {
  it('writes to the port instead of the queue when the name is one', async () => {
    // The reason this exists: the EPSON driver accepts raw ESC/POS, reports it
    // written, and prints nothing. A port has no such opinion.
    const queue = createMockPrinterAdapter();
    const port = recorder();
    const adapter = withDirectPorts(queue, { write: port.write });

    const result = await adapter.printRaw(TICKET, configFor('COM3'));

    expect(result).toMatchObject({ ok: true, bytesSent: 3 });
    expect(port.writes).toHaveLength(1);
    expect(port.writes[0]?.target).toEqual({ kind: 'device', path: '\\\\.\\COM3' });
    expect(queue.calls).toHaveLength(0);
  });

  it('still uses the queue for a queue name', async () => {
    const queue = createMockPrinterAdapter();
    const port = recorder();
    const adapter = withDirectPorts(queue, { write: port.write });

    await adapter.printRaw(TICKET, configFor('EPSON TM-T88V Receipt5'));

    expect(queue.calls).toHaveLength(1);
    expect(port.writes).toHaveLength(0);
  });

  it('says which port failed, and why', async () => {
    const adapter = withDirectPorts(createMockPrinterAdapter(), {
      write: recorder('ENOENT: no such file or directory').write,
    });

    const result = await adapter.printRaw(TICKET, configFor('COM9'));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('COM9');
    expect(result.error).toContain('ENOENT');
  });

  it('sends the diagnostic ticket by the same route as a receipt', async () => {
    // Otherwise the test print would exercise the driver that does not work,
    // and report that everything is fine.
    const port = recorder();
    const adapter = withDirectPorts(createMockPrinterAdapter(), { write: port.write });

    const result = await adapter.printTest(configFor('COM3'));

    expect(result.ok).toBe(true);
    expect(port.writes).toHaveLength(1);
    expect(port.writes[0]?.bytes.length).toBeGreaterThan(0);
  });

  it('forwards the driver\'s text mode instead of dropping it', async () => {
    // The wrapper rebuilds the adapter object, and forgetting one optional
    // method is invisible to the type checker on the way out. It cost a till a
    // release: "this driver cannot print text", about a driver that can.
    const texts: string[] = [];
    const queue = {
      ...createMockPrinterAdapter(),
      printText: (text: string) => {
        texts.push(text);
        return Promise.resolve({ ok: true, bytesSent: text.length });
      },
    };

    const adapter = withDirectPorts(queue);
    const result = await adapter.printText?.('TOTAL 12,00 €', configFor('EPSON TM-T88V Receipt5'));

    expect(result).toMatchObject({ ok: true });
    expect(texts).toEqual(['TOTAL 12,00 €']);
  });

  it('keeps every optional capability the wrapped driver has', () => {
    const queue = {
      ...createMockPrinterAdapter(),
      printText: () => Promise.resolve({ ok: true }),
      printDocument: () => Promise.resolve({ ok: true }),
    };
    const adapter = withDirectPorts(queue);
    expect(typeof adapter.printText).toBe('function');
    expect(typeof adapter.printDocument).toBe('function');
  });

  it('writes text to a port as bytes, since a port lays nothing out', async () => {
    const port = recorder();
    const adapter = withDirectPorts(createMockPrinterAdapter(), { write: port.write });

    await adapter.printText?.('TOTAL', configFor('COM3'));

    expect(port.writes).toHaveLength(1);
    expect(port.writes[0]?.target).toEqual({ kind: 'device', path: '\\\\.\\COM3' });
  });

  it('still lists the machine queues, which a port does not replace', async () => {
    const adapter = withDirectPorts(createMockPrinterAdapter());
    expect((await adapter.list()).length).toBeGreaterThan(0);
  });
});

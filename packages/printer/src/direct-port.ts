import { writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import type { Printer } from '@brb/shared';
import type { PrinterAdapter, PrinterConfig, PrintResult } from './types.ts';

/**
 * Write the ticket straight to a port, with no queue and no driver.
 *
 * WHY THIS EXISTS. Found on a real till: EPSON's Advanced Printer Driver owns
 * the queue, generates its own ESC/POS from what Windows renders, and silently
 * DISCARDS a job handed to it already in ESC/POS. The spooler accepts the
 * bytes, the queue empties, `WritePrinter` reports them written - and no paper
 * comes out. A Windows test page prints, which is what makes it so confusing:
 * the printer works, the path we were using does not.
 *
 * A port has no such opinion. `COM3` from EPSON's TM Virtual Port, `LPT1`, or a
 * network printer's port 9100: the bytes reach the device as written.
 *
 * The port is named in the CONFIGURATION, in place of a queue name. Nothing is
 * guessed: a name that is not unmistakably a port is sent to the platform's
 * queue exactly as before.
 */

export type PortTarget =
  | { kind: 'device'; path: string }
  | { kind: 'tcp'; host: string; port: number };

/** How long to wait for a network printer before giving up. */
export const TCP_TIMEOUT_MS = 10_000;

/**
 * Read a configured name as a port, or decide it is a queue name.
 *
 * Deliberately narrow. A queue can be called almost anything, so anything not
 * unmistakably a port stays a queue: printing to the wrong place is worse than
 * not printing.
 */
export function parsePortTarget(name: string): PortTarget | undefined {
  const trimmed = name.trim();

  if (/^(?:COM|LPT)\d+:?$/i.test(trimmed)) {
    // Windows needs the device namespace for a port above 9, and accepts it
    // for all of them.
    return { kind: 'device', path: `\\\\.\\${trimmed.replace(/:$/, '').toUpperCase()}` };
  }
  if (/^\\\\\.\\[A-Za-z0-9_-]+$/.test(trimmed)) {
    return { kind: 'device', path: trimmed };
  }
  if (/^\/dev\/[A-Za-z0-9/_.-]+$/.test(trimmed)) {
    return { kind: 'device', path: trimmed };
  }

  const network = /^(?:tcp:\/\/)?([A-Za-z0-9._-]+):(\d{1,5})$/.exec(trimmed);
  if (network !== null) {
    const port = Number(network[2]);
    if (port > 0 && port <= 65_535) {
      return { kind: 'tcp', host: network[1] as string, port };
    }
  }
  return undefined;
}

export interface DirectPortOptions {
  /** Overridable so a test writes nothing to a real device. */
  write?: (target: PortTarget, bytes: Uint8Array) => Promise<void>;
}

export async function writeToPort(target: PortTarget, bytes: Uint8Array): Promise<void> {
  if (target.kind === 'device') {
    // Opened and closed per job: a till prints a few tickets a minute, and a
    // handle held open is a handle to lose on a cable knock.
    await writeFile(target.path, bytes, { flag: 'a' });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: target.host, port: target.port });
    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.on('timeout', () => {
      socket.destroy(new Error(`${target.host}:${target.port} n'a pas répondu à temps.`));
    });
    socket.on('error', reject);
    socket.end(bytes, () => {
      resolve();
    });
  });
}

/**
 * Send to a port when the configured name is one, and to the queue otherwise.
 *
 * A wrapper rather than a separate adapter: listing the machine's queues still
 * has to work, and a port is a choice made for one printer, not a different
 * kind of machine.
 */
export function withDirectPorts(
  adapter: PrinterAdapter,
  options: DirectPortOptions = {},
): PrinterAdapter {
  const write = options.write ?? writeToPort;

  const printRaw = async (bytes: Uint8Array, config: PrinterConfig): Promise<PrintResult> => {
    const target = parsePortTarget(config.name);
    if (target === undefined) return adapter.printRaw(bytes, config);

    try {
      await write(target, bytes);
      return { ok: true, bytesSent: bytes.length };
    } catch (error) {
      return {
        ok: false,
        error: `Écriture sur ${config.name} impossible : ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  };

  const printTest = async (config: PrinterConfig): Promise<PrintResult> => {
    if (parsePortTarget(config.name) === undefined) return adapter.printTest(config);
    // The diagnostic ticket is ESC/POS like any other, so it takes the same
    // route rather than the driver's.
    const [{ buildTestTicketLayout }, { emitEscPos }] = await Promise.all([
      import('./test-ticket.ts'),
      import('@brb/receipt-renderer'),
    ]);
    const { bytes, unmapped } = emitEscPos(buildTestTicketLayout(config), {
      ...(config.cutFeedDots === undefined ? {} : { cutFeedDots: config.cutFeedDots }),
    });
    const result = await printRaw(bytes, config);
    return { ...result, unmapped };
  };

  /**
   * Text goes to the port as bytes, and to a queue as text.
   *
   * A port has no print processor to lay anything out, so the fallback that
   * exists for a driver refusing ESC/POS is meaningless there: the bytes are
   * simply written.
   */
  const printText = async (text: string, config: PrinterConfig): Promise<PrintResult> => {
    if (parsePortTarget(config.name) === undefined) {
      if (adapter.printText === undefined) {
        return { ok: false, error: "Ce pilote ne sait pas imprimer du texte sur ce poste." };
      }
      return adapter.printText(text, config);
    }
    const { toWindowsAnsi } = await import('./windows-ansi.ts');
    return printRaw(toWindowsAnsi(text), config);
  };

  const list = (): Promise<Printer[]> => adapter.list();

  // Every optional capability is forwarded explicitly. Rebuilding the object
  // and forgetting one is how `printText` vanished between the driver that
  // implements it and the code that needs it - the till reported "this driver
  // cannot print text" about a driver that can.
  return {
    list,
    printRaw,
    printTest,
    printText,
    // A port takes bytes, not a document: an ordinary printer is reached
    // through its queue, which is what the wrapped adapter is for.
    ...(adapter.printDocument === undefined
      ? {}
      : { printDocument: adapter.printDocument.bind(adapter) }),
  };
}

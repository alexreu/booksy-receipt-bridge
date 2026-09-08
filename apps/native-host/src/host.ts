import { createMockPrinterAdapter, createWindowsPrinterAdapter, type PrinterAdapter } from '@brb/printer';
import { systemClock, type Clock, type NativeResponse } from '@brb/shared';
import { loadConfig } from './config/config.ts';
import { createLogger, type Logger } from './logging/logger.ts';
import { dispatch, withinResponseLimit, type HostContext } from './messaging/dispatch.ts';
import { configPath, dataDir, logDir } from './paths.ts';
import { join } from 'node:path';
import { HOST_VERSION } from './version.ts';

export interface CreateHostOptions {
  /** Overridable for tests. */
  printer?: PrinterAdapter;
  printerAdapter?: string;
  log?: Logger;
  configFile?: string;
  historyPath?: string;
  updateDir?: string;
  /** Injected so a test never reaches the network. */
  fetch?: typeof fetch;
  /** Injected so a test can pin every timestamp the host produces. */
  clock?: Clock;
}

export interface Host {
  context: HostContext;
  handle: (raw: unknown) => Promise<NativeResponse>;
}

/**
 * Pick the printing implementation.
 *
 * Windows on Windows, mock elsewhere - and `printerAdapter` reports which,
 * because a green tick in the popup backed by a mock would be a lie told to the
 * user's UI. `BRB_PRINTER` forces a choice, which is how the pipeline gets
 * exercised end to end on a machine that has no spooler at all.
 */
function selectPrinter(env: NodeJS.ProcessEnv): { printer: PrinterAdapter; name: string } {
  const forced = env['BRB_PRINTER'];
  if (forced === 'mock') return { printer: createMockPrinterAdapter(), name: 'mock' };
  if (forced === 'windows') return { printer: createWindowsPrinterAdapter(), name: 'windows' };

  if (process.platform === 'win32') {
    return { printer: createWindowsPrinterAdapter(), name: 'windows' };
  }
  return { printer: createMockPrinterAdapter(), name: 'mock' };
}

/**
 * Assemble the host.
 *
 * Everything the dispatcher needs is passed in, so the whole message surface can
 * be driven in tests without touching a real config file or a real spooler.
 */
export function createHost(options: CreateHostOptions = {}): Host {
  const clock = options.clock ?? systemClock;
  const log = options.log ?? createLogger({ dir: logDir(), now: clock });
  const file = options.configFile ?? configPath();
  const config = loadConfig(file);

  if (config.error !== undefined) log.warn(config.error);
  if (!config.present) log.info(`Aucune configuration à ${file}, valeurs par défaut utilisées.`);

  const selected = selectPrinter(process.env);
  const context: HostContext = {
    version: HOST_VERSION,
    config,
    printer: options.printer ?? selected.printer,
    printerAdapter: options.printerAdapter ?? selected.name,
    log,
    clock,
    configFile: file,
    historyPath: options.historyPath ?? join(dataDir(), 'print-history.json'),
    updateDir: options.updateDir ?? join(dataDir(), 'updates'),
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
  };

  return {
    context,
    handle: async (raw) => withinResponseLimit(await dispatch(raw, context)),
  };
}

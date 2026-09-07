import { MockPrinterAdapter, type PrinterAdapter } from '@brb/printer';
import type { NativeResponse } from '@brb/shared';
import { loadConfig } from './config/config.ts';
import { createLogger, type Logger } from './logging/logger.ts';
import { dispatch, withinResponseLimit, type HostContext } from './messaging/dispatch.ts';
import { configPath, logDir } from './paths.ts';
import { HOST_VERSION } from './version.ts';

export interface CreateHostOptions {
  /** Overridable for tests. */
  printer?: PrinterAdapter;
  printerAdapter?: string;
  log?: Logger;
  configFile?: string;
}

export interface Host {
  context: HostContext;
  handle: (raw: unknown) => Promise<NativeResponse>;
}

/**
 * Assemble the host.
 *
 * The printer is injected. Until phase 6 there is no Windows implementation, so
 * the default is the mock - and `printerAdapter` says so, which is why
 * GET_STATUS reports the implementation name: a green tick backed by a mock
 * would be a lie told to the user's UI.
 */
export function createHost(options: CreateHostOptions = {}): Host {
  const log = options.log ?? createLogger({ dir: logDir() });
  const file = options.configFile ?? configPath();
  const config = loadConfig(file);

  if (config.error !== undefined) log.warn(config.error);
  if (!config.present) log.info(`Aucune configuration à ${file}, valeurs par défaut utilisées.`);

  const context: HostContext = {
    version: HOST_VERSION,
    config,
    printer: options.printer ?? new MockPrinterAdapter(),
    printerAdapter: options.printerAdapter ?? 'mock',
    log,
  };

  return {
    context,
    handle: async (raw) => withinResponseLimit(await dispatch(raw, context)),
  };
}

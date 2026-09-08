import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '@brb/shared';

/**
 * Host logging (plan section 39).
 *
 * STDOUT IS THE PROTOCOL. Chrome reads length-prefixed JSON from this process's
 * stdout, so a single byte of diagnostics there corrupts the stream and the
 * extension sees the host die with nothing to go on. Everything here goes to a
 * file and, optionally, to stderr.
 *
 * Never log customer data. Ticket numbers and amounts are fine; names, customer
 * ids and addresses are not - a receipt printer's log is not the place for them.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Path of the file being written, when there is one. */
  readonly file?: string;
}

export interface LoggerOptions {
  /** Directory for the log file. Logging is stderr-only when absent. */
  dir?: string;
  level?: LogLevel;
  /** Mirror to stderr. Default true. */
  stderr?: boolean;
  /** Required, not defaulted: the log's timestamps are part of its output. */
  now: Clock;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LOG_LEVELS.indexOf(options.level ?? 'info');
  const toStderr = options.stderr ?? true;
  const now = (): Date => new Date(options.now());

  let file: string | undefined;
  if (options.dir !== undefined) {
    try {
      mkdirSync(options.dir, { recursive: true });
      file = join(options.dir, `host-${now().toISOString().slice(0, 10)}.log`);
    } catch {
      // A read-only or missing data directory must not stop the host from
      // running; it just loses the file log.
      file = undefined;
    }
  }

  const write = (level: LogLevel, message: string): void => {
    if (LOG_LEVELS.indexOf(level) < threshold) return;
    const stamp = now().toTimeString().slice(0, 8);
    const line = `${stamp} ${level.toUpperCase().padEnd(5)} ${message}\n`;

    if (file !== undefined) {
      try {
        appendFileSync(file, line, 'utf8');
      } catch {
        // Ignore: losing a log line is never worth failing a print job.
      }
    }
    if (toStderr) process.stderr.write(line);
  };

  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    ...(file === undefined ? {} : { file }),
  };
}

/** Discards everything. For tests and for the CLI's quiet mode. */
export function silentLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

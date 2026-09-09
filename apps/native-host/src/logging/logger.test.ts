import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '@brb/shared';
import { createLogger, silentLogger } from './logger.ts';

/** A fixed instant, so the timestamps in the log are assertable. */
const AT = Date.parse('2026-03-14T15:09:07Z');

let dir: string;
// Inferred rather than annotated: process.stdout.write is overloaded, and a
// hand-written MockInstance type for it does not match what spyOn returns.
let stdoutSpy: ReturnType<typeof spyOnStdout>;
let stderrSpy: ReturnType<typeof spyOnStderr>;

function spyOnStdout() {
  return vi.spyOn(process.stdout, 'write').mockReturnValue(true);
}

function spyOnStderr() {
  return vi.spyOn(process.stderr, 'write').mockReturnValue(true);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brb-log-'));
  stdoutSpy = spyOnStdout();
  stderrSpy = spyOnStderr();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function logFile(): string {
  const files = readdirSync(dir);
  return readFileSync(join(dir, files[0] ?? ''), 'utf8');
}

describe('createLogger', () => {
  it('never writes to stdout - stdout is the Native Messaging channel', () => {
    // A single byte of diagnostics on stdout corrupts the frame stream and the
    // extension sees the host die with nothing to go on.
    const log = createLogger({ dir, now: fixedClock(AT) });
    log.info('bonjour');
    log.warn('attention');
    log.error('erreur');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('writes to stderr', () => {
    createLogger({ dir, stderr: true, now: fixedClock(AT) }).info('bonjour');
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('bonjour');
  });

  it('can be silent on stderr and still write the file', () => {
    createLogger({ dir, stderr: false, now: fixedClock(AT) }).info('fichier seulement');
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(logFile()).toContain('fichier seulement');
  });

  it('names the file by date and reports its path', () => {
    const log = createLogger({ dir, now: fixedClock(Date.parse('2026-03-14T15:09:00Z')) });
    log.info('x');
    expect(log.file).toContain('host-2026-03-14.log');
  });

  it('formats as time, level, message', () => {
    createLogger({ dir, now: fixedClock(AT) }).info('Ticket 1167 imprimé');
    expect(logFile()).toMatch(/^\d{2}:\d{2}:07 INFO {2}Ticket 1167 imprimé\n$/);
  });

  it('honours the level threshold', () => {
    const log = createLogger({ dir, level: 'warn', now: fixedClock(AT) });
    log.debug('invisible');
    log.info('invisible');
    log.warn('visible');
    const contents = logFile();
    expect(contents).not.toContain('invisible');
    expect(contents).toContain('visible');
  });

  it('appends rather than truncating', () => {
    const log = createLogger({ dir, now: fixedClock(AT) });
    log.info('un');
    log.info('deux');
    expect(logFile().trim().split('\n')).toHaveLength(2);
  });

  it('keeps working when the directory cannot be created', () => {
    // A locked-down machine must not stop the host from printing.
    //
    // A directory INSIDE A FILE, rather than a path that happens to be
    // unwritable on this OS: /proc is writable-looking on Windows, where the
    // runner created it happily and the test went red for the wrong reason.
    // Creating a directory under a regular file fails everywhere.
    const blocked = join(dir, 'un-fichier');
    writeFileSync(blocked, 'pas un dossier');
    const log = createLogger({ dir: join(blocked, 'brb'), now: fixedClock(AT) });
    expect(log.file).toBeUndefined();
    expect(() => log.error('toujours vivant')).not.toThrow();
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('logs nothing at all when given no directory and no stderr', () => {
    createLogger({ stderr: false, now: fixedClock(AT) }).error('nulle part');
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe('silentLogger', () => {
  it('discards everything', () => {
    const log = silentLogger();
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(log.file).toBeUndefined();
  });
});

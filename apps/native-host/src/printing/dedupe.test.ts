import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '@brb/shared';
import {
  AUTO_WINDOW_MS,
  USER_WINDOW_MS,
  checkAndRecord,
  dedupeKey,
  windowFor,
} from './dedupe.ts';

let path: string;

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'brb-dedupe-')), 'print-history.json');
});

describe('checkAndRecord', () => {
  it('lets the first print through', () => {
    expect(checkAndRecord('k', { path, windowMs: USER_WINDOW_MS, now: fixedClock(1_000) })).toEqual({ duplicate: false });
  });

  it('catches a second print of the same receipt', () => {
    // The point of the whole module: the second click of a double-click.
    checkAndRecord('k', { path, windowMs: USER_WINDOW_MS, now: fixedClock(1_000) });
    expect(checkAndRecord('k', { path, windowMs: USER_WINDOW_MS, now: fixedClock(1_000) })).toEqual({ duplicate: true });
  });

  it('survives the host process restarting between the two', () => {
    // sendNativeMessage starts a fresh process per message, so the history has
    // to be on disk - an in-memory guard would never see the second click.
    checkAndRecord('k', { path, windowMs: USER_WINDOW_MS, now: fixedClock(1_000) });
    // Nothing is carried over in this test but the file itself.
    expect(checkAndRecord('k', { path, windowMs: USER_WINDOW_MS, now: fixedClock(1_000) }).duplicate).toBe(true);
  });

  it('lets the same receipt through once the window has passed', () => {
    let now = 1_000_000;
    const clock = (): number => now;
    checkAndRecord('k', { path, windowMs: 60_000, now: clock });
    now += 59_000;
    expect(checkAndRecord('k', { path, windowMs: 60_000, now: clock }).duplicate).toBe(true);
    now += 61_000;
    expect(checkAndRecord('k', { path, windowMs: 60_000, now: clock }).duplicate).toBe(false);
  });

  it('pushes the window out on a repeat, so the third click is caught too', () => {
    let now = 1_000_000;
    const clock = (): number => now;
    checkAndRecord('k', { path, windowMs: 60_000, now: clock });
    now += 50_000;
    checkAndRecord('k', { path, windowMs: 60_000, now: clock });
    now += 50_000;
    expect(checkAndRecord('k', { path, windowMs: 60_000, now: clock }).duplicate).toBe(true);
  });

  it('keeps different receipts independent', () => {
    checkAndRecord('a', { path, windowMs: USER_WINDOW_MS, now: fixedClock(1_000) });
    expect(checkAndRecord('b', { path, windowMs: USER_WINDOW_MS, now: fixedClock(1_000) }).duplicate).toBe(false);
  });

  it('treats a corrupt history as empty rather than refusing to print', () => {
    // At worst a duplicate slips through; refusing to print would be worse.
    writeFileSync(path, '{ not json');
    expect(checkAndRecord('k', { path, windowMs: USER_WINDOW_MS, now: fixedClock(1_000) }).duplicate).toBe(false);
  });

  it('ignores malformed entries in an otherwise valid history', () => {
    writeFileSync(path, JSON.stringify([{ key: 'k' }, 'nope', { at: 1 }, null]));
    expect(checkAndRecord('k', { path, windowMs: USER_WINDOW_MS, now: fixedClock(1_000) }).duplicate).toBe(false);
  });

  it('does not fail when the history cannot be written', () => {
    const unwritable = '/proc/definitely-not-writable/history.json';
    expect(() => checkAndRecord('k', { path: unwritable, windowMs: 1000, now: fixedClock(1_000) })).not.toThrow();
  });
});

describe('dedupeKey', () => {
  it('identifies a user print by what is printed on the ticket', () => {
    const key = dedupeKey(
      'user',
      { ticketNumber: '1167', issuedAt: '11/08/2026, 16:08:54', totalTTC: 300 },
      'abc',
    );
    expect(key).toBe('ticket:1167|11/08/2026, 16:08:54|300.00');
  });

  it('identifies an automatic print by the file hash', () => {
    // So re-downloading the same receipt cannot produce a second ticket, even
    // if something else about the document shifted.
    expect(dedupeKey('auto', { ticketNumber: '1167', totalTTC: 300 }, 'abc123')).toBe(
      'sha256:abc123',
    );
  });

  it('separates two receipts that differ only in total', () => {
    const a = dedupeKey('user', { ticketNumber: '1', totalTTC: 10 }, 'x');
    const b = dedupeKey('user', { ticketNumber: '1', totalTTC: 20 }, 'x');
    expect(a).not.toBe(b);
  });
});

describe('windowFor', () => {
  it('protects a click for minutes and an automatic trigger for an hour', () => {
    expect(windowFor('user')).toBe(USER_WINDOW_MS);
    expect(windowFor('auto')).toBe(AUTO_WINDOW_MS);
    expect(AUTO_WINDOW_MS).toBeGreaterThan(USER_WINDOW_MS);
  });
});

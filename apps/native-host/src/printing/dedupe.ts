import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Stop the same receipt printing twice (plan section 54).
 *
 * ON DISK, NOT IN MEMORY. `chrome.runtime.sendNativeMessage` starts a fresh
 * host process for every message, so anything remembered in a variable is gone
 * before the second click arrives - which is precisely the click this is meant
 * to catch. That is a direct consequence of choosing one-shot messages over a
 * long-lived port (plan section 2.3), and it is why the history is a file.
 *
 * KNOWN LIMIT: two host processes racing on the same receipt can both read the
 * history before either writes it, and print twice. Narrowing that would mean
 * real file locking; the protection window is what actually does the work here,
 * and the cost of losing the race is one extra ticket.
 */

/** Double-click protection for a person pressing the button. */
export const USER_WINDOW_MS = 120_000;

/** A re-download of the same file should not print again for a good while. */
export const AUTO_WINDOW_MS = 60 * 60_000;

interface HistoryEntry {
  key: string;
  at: number;
}

export interface DedupeOptions {
  path: string;
  windowMs: number;
  now?: () => number;
}

/**
 * Record a print, and say whether it had already happened inside the window.
 *
 * Records even when it reports a duplicate: pressing the button repeatedly
 * should keep pushing the window out, not let the third click through.
 */
export function checkAndRecord(key: string, options: DedupeOptions): { duplicate: boolean } {
  const now = options.now?.() ?? Date.now();
  const entries = read(options.path).filter((entry) => now - entry.at < options.windowMs);
  const duplicate = entries.some((entry) => entry.key === key);

  const kept = [...entries.filter((entry) => entry.key !== key), { key, at: now }];
  write(options.path, kept);
  return { duplicate };
}

/**
 * The key a receipt is remembered by.
 *
 * A person clicking twice is identified by what is printed on the ticket. An
 * automatic trigger is identified by the file's hash instead, so re-downloading
 * the same receipt cannot produce a second ticket even if the reprint counter
 * or anything else about it shifted.
 */
export function dedupeKey(
  trigger: 'user' | 'auto',
  receipt: { ticketNumber: string; issuedAt?: string; totalTTC: number },
  sha256: string,
): string {
  if (trigger === 'auto') return `sha256:${sha256}`;
  return `ticket:${receipt.ticketNumber}|${receipt.issuedAt ?? ''}|${receipt.totalTTC.toFixed(2)}`;
}

export function windowFor(trigger: 'user' | 'auto'): number {
  return trigger === 'auto' ? AUTO_WINDOW_MS : USER_WINDOW_MS;
}

function read(path: string): HistoryEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const record = entry as Record<string, unknown>;
      const key = record['key'];
      const at = record['at'];
      if (typeof key !== 'string' || typeof at !== 'number') return [];
      return [{ key, at }];
    });
  } catch {
    // No history yet, or a corrupt file. Treating it as empty means at worst a
    // duplicate gets through; refusing to print would be the worse failure.
    return [];
  }
}

function write(path: string, entries: readonly HistoryEntry[]): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(entries), 'utf8');
    renameSync(temporary, path);
  } catch {
    // Losing the history must not fail a print job.
  }
}

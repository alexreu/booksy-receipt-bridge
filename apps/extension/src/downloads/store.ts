import type { ParseWarning } from '@brb/shared';

/**
 * Receipts spotted in the downloads, kept where the service worker can find
 * them again.
 *
 * IN STORAGE, NOT IN A VARIABLE. An MV3 service worker is evicted after about
 * 30 seconds idle: the download event wakes it, and by the time the user opens
 * the popup it has almost certainly been shut down again. Session storage is
 * the right shelf - it survives that eviction and is cleared when the browser
 * closes, which is the lifetime a "just downloaded" list should have.
 */

export interface DetectedReceipt {
  downloadId: number;
  /** Absolute local path. The host re-validates it before opening it. */
  path: string;
  ticketNumber: string;
  totalTTC: number;
  issuedAt?: string;
  confidence: number;
  warningCount: number;
  detectedAt: number;
  /** Set once printed, so the popup can say so instead of offering again. */
  printedAt?: number;
  reason: 'booksy' | 'filename';
}

export const STORAGE_KEY = 'detectedReceipts';

/**
 * Download ids already offered to the host, receipt or not.
 *
 * Without this, every popup opening would re-parse the same unrelated PDFs, and
 * a rejected download would be asked about again and again.
 */
export const CHECKED_KEY = 'checkedDownloadIds';

/** Enough to cover a browsing session's downloads without growing unbounded. */
export const MAX_CHECKED = 100;

/** Kept short: this is a "just now" list, not a history. */
export const MAX_DETECTED = 10;

/** The slice of chrome.storage this needs, so tests need no browser. */
export interface SessionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function readDetected(storage: SessionStorage): Promise<DetectedReceipt[]> {
  const stored = await storage.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter(isDetected);
}

/**
 * Add or replace an entry.
 *
 * Keyed by download id, so a download that fires several change events cannot
 * appear twice, and newest first because that is the one the user just made.
 */
export async function rememberDetected(
  storage: SessionStorage,
  receipt: DetectedReceipt,
): Promise<DetectedReceipt[]> {
  const existing = await readDetected(storage);
  const next = [
    receipt,
    ...existing.filter((entry) => entry.downloadId !== receipt.downloadId),
  ].slice(0, MAX_DETECTED);
  await storage.set({ [STORAGE_KEY]: next });
  return next;
}

export async function updateDetected(
  storage: SessionStorage,
  downloadId: number,
  patch: Partial<DetectedReceipt>,
): Promise<DetectedReceipt[]> {
  const next = (await readDetected(storage)).map((entry) =>
    entry.downloadId === downloadId ? { ...entry, ...patch } : entry,
  );
  await storage.set({ [STORAGE_KEY]: next });
  return next;
}

export async function forgetDetected(
  storage: SessionStorage,
  downloadId: number,
): Promise<DetectedReceipt[]> {
  const next = (await readDetected(storage)).filter(
    (entry) => entry.downloadId !== downloadId,
  );
  await storage.set({ [STORAGE_KEY]: next });
  return next;
}

export async function readChecked(storage: SessionStorage): Promise<number[]> {
  const stored = await storage.get(CHECKED_KEY);
  const value = stored[CHECKED_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is number => typeof entry === 'number');
}

export async function markChecked(
  storage: SessionStorage,
  downloadId: number,
): Promise<number[]> {
  const existing = await readChecked(storage);
  if (existing.includes(downloadId)) return existing;
  const next = [downloadId, ...existing].slice(0, MAX_CHECKED);
  await storage.set({ [CHECKED_KEY]: next });
  return next;
}

/** How many entries still await a decision - what the badge counts. */
export function pendingCount(receipts: readonly DetectedReceipt[]): number {
  return receipts.filter((receipt) => receipt.printedAt === undefined).length;
}

export function warningCountOf(warnings: readonly ParseWarning[]): number {
  return warnings.length;
}

function isDetected(value: unknown): value is DetectedReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['downloadId'] === 'number' &&
    typeof record['path'] === 'string' &&
    typeof record['ticketNumber'] === 'string' &&
    typeof record['totalTTC'] === 'number' &&
    typeof record['confidence'] === 'number' &&
    typeof record['detectedAt'] === 'number'
  );
}

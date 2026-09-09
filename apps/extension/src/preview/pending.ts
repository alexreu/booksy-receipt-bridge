import type { Clock, ReceiptSource } from '@brb/shared';
import type { SessionStorage } from '../storage.ts';

/**
 * A receipt captured and waiting to be approved.
 *
 * THE PAGE NEVER HOLDS THE CONTENT. It is given an id and nothing else; the
 * worker keeps the source in session storage and does the rendering and the
 * printing itself. Nothing that reaches a page's world decides what is printed.
 *
 * ONE SOURCE, USED TWICE. A tab's PDF has no path, so its bytes are captured
 * once - there is nothing to re-read. The rendering and the print are then
 * handed the same bytes, so what was approved on screen is what goes to the
 * printer.
 */

export interface PendingPreview {
  id: string;
  /** Exactly what the host will be handed, for both rendering and printing. */
  source: ReceiptSource;
  /** For the preview's title, when known. */
  label?: string;
  createdAt: number;
}

export const PENDING_KEY = 'pendingPreviews';

/**
 * Kept small on purpose: this is a queue of one decision, not a spool. Session
 * storage has a modest quota and a receipt is worth a few kilobytes.
 */
export const MAX_PENDING = 3;

export async function readPending(storage: SessionStorage): Promise<PendingPreview[]> {
  const stored = await storage.get(PENDING_KEY);
  const value = stored[PENDING_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter(isPending);
}

export async function addPending(
  storage: SessionStorage,
  preview: PendingPreview,
): Promise<PendingPreview[]> {
  const existing = await readPending(storage);
  const next = [preview, ...existing.filter((entry) => entry.id !== preview.id)].slice(
    0,
    MAX_PENDING,
  );
  await storage.set({ [PENDING_KEY]: next });
  return next;
}

export async function findPending(
  storage: SessionStorage,
  id: string,
): Promise<PendingPreview | undefined> {
  return (await readPending(storage)).find((entry) => entry.id === id);
}

export async function dropPending(
  storage: SessionStorage,
  id: string,
): Promise<PendingPreview[]> {
  const next = (await readPending(storage)).filter((entry) => entry.id !== id);
  await storage.set({ [PENDING_KEY]: next });
  return next;
}

/** An id that is unique for this session and readable in a URL. */
export function previewId(clock: Clock, existing: readonly PendingPreview[]): string {
  return `p-${clock().toString(36)}-${existing.length.toString(36)}`;
}

function isPending(value: unknown): value is PendingPreview {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const source = record['source'];
  return (
    typeof record['id'] === 'string' &&
    typeof record['createdAt'] === 'number' &&
    typeof source === 'object' &&
    source !== null &&
    ((source as { kind?: unknown }).kind === 'bytes' ||
      (source as { kind?: unknown }).kind === 'path')
  );
}

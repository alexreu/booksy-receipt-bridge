import type { Clock, ParseResult } from '@brb/shared';
import { nextMessageId, type NativeHostClient } from '../messaging/client.ts';
import {
  candidateReason,
  isCandidate,
  type DownloadCandidate,
} from './filter.ts';
import {
  markChecked,
  pendingCount,
  readChecked,
  readDetected,
  rememberDetected,
  type DetectedReceipt,
  type SessionStorage,
} from './store.ts';

export interface WatcherDeps {
  client: NativeHostClient;
  storage: SessionStorage;
  /** Look a download up by id; only `onChanged` fires, and it carries no path. */
  lookup: (downloadId: number) => Promise<DownloadCandidate | undefined>;
  /** Recent downloads, newest first. Used to recover missed detections. */
  recent?: (limit: number) => Promise<DownloadCandidate[]>;
  /** Show how many receipts await a decision. */
  setBadge?: (count: number) => void;
  log?: (message: string) => void;
  /** Required, not defaulted: `detectedAt` is data the popup shows. */
  now: Clock;
}

export type WatchOutcome =
  | { kind: 'ignored'; why: 'not-a-candidate' | 'unknown-download' }
  | { kind: 'rejected'; why: string }
  | { kind: 'detected'; receipt: DetectedReceipt };

/**
 * Handle one finished download.
 *
 * The filename is never trusted as proof (plan section 20): the extension only
 * decides a download is worth a look, and the host opens it and says whether it
 * is really a Booksy receipt (plan section 21).
 *
 * NOTHING IS PRINTED HERE. Detection and printing are separate on purpose - the
 * user is offered a button, and automatic printing is a later phase behind its
 * own setting (plan sections 4 and 66).
 */
export async function handleFinishedDownload(
  downloadId: number,
  deps: WatcherDeps,
): Promise<WatchOutcome> {
  const candidate = await deps.lookup(downloadId);
  if (candidate === undefined) {
    return { kind: 'ignored', why: 'unknown-download' };
  }
  if (!isCandidate(candidate)) {
    return { kind: 'ignored', why: 'not-a-candidate' };
  }

  // Recorded before the host is asked, not after: if this attempt is lost the
  // reconciliation below will retry it, but a PDF that is simply not a receipt
  // must not be re-parsed on every popup opening.
  await markChecked(deps.storage, downloadId);

  // Ask the host to read it. Only PARSE_RECEIPT - reading is not printing, and
  // the host validates the path against its allowed directories anyway.
  const response = await deps.client.send<ParseResult>({
    id: nextMessageId(),
    type: 'PARSE_RECEIPT',
    payload: { source: { kind: 'path', path: candidate.filename } },
  });

  if (!response.success || response.data === undefined) {
    const why = response.error?.message ?? 'Lecture impossible.';
    // Expected for any PDF that simply is not a receipt, so this is not an
    // error the user needs to see - it is the filter working.
    deps.log?.(`Téléchargement ignoré : ${why}`);
    return { kind: 'rejected', why };
  }

  const { receipt, confidence, warnings } = response.data;
  const detected: DetectedReceipt = {
    downloadId,
    path: candidate.filename,
    ticketNumber: receipt.ticket.number,
    totalTTC: receipt.totals.totalTTC,
    ...(receipt.ticket.issuedAt === undefined ? {} : { issuedAt: receipt.ticket.issuedAt }),
    confidence,
    warningCount: warnings.length,
    detectedAt: deps.now(),
    reason: candidateReason(candidate),
  };

  const all = await rememberDetected(deps.storage, detected);
  deps.setBadge?.(pendingCount(all));
  deps.log?.(`Reçu Booksy détecté, ticket ${detected.ticketNumber}`);

  return { kind: 'detected', receipt: detected };
}

/** Recompute the badge, for use after a print or a dismissal. */
export async function refreshBadge(deps: WatcherDeps): Promise<number> {
  const count = pendingCount(await readDetected(deps.storage));
  deps.setBadge?.(count);
  return count;
}

/** How many recent downloads the recovery pass looks at. */
export const RECONCILE_LIMIT = 20;

/**
 * Catch up on downloads whose detection never completed.
 *
 * WHY THIS EXISTS. An MV3 service worker can be evicted while a native call is
 * in flight - `sendNativeMessage` does not hold it alive the way an open port
 * would - and the host process dies with it. Observed in a real browser: the
 * download finished, the host was launched, the worker was shut down, and the
 * connection was never closed. The detection only landed on a later wake-up.
 *
 * Rather than fight for the worker's lifetime, detection is made recoverable.
 * This runs when the popup asks for the list, so it also covers a browser
 * restart and an extension installed after the download.
 */
export async function reconcileDownloads(deps: WatcherDeps): Promise<DetectedReceipt[]> {
  if (deps.recent === undefined) return readDetected(deps.storage);

  const checked = new Set(await readChecked(deps.storage));
  const known = new Set((await readDetected(deps.storage)).map((entry) => entry.downloadId));

  const pendingIds = (await deps.recent(RECONCILE_LIMIT))
    .filter((candidate) => !checked.has(candidate.id) && !known.has(candidate.id))
    .filter((candidate) => isCandidate(candidate))
    .map((candidate) => candidate.id);

  for (const downloadId of pendingIds) {
    await handleFinishedDownload(downloadId, deps);
  }

  const all = await readDetected(deps.storage);
  deps.setBadge?.(pendingCount(all));
  return all;
}

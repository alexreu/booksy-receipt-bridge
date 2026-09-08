import type {
  BridgeConfig,
  UpdateCheck,
  UpdateDownload,
  ConfigPatch,
  Printer,
  PrintReceiptData,
  PrintTestData,
} from '@brb/shared';
import type { DetectedReceipt } from '../downloads/store.ts';
import type { HostState } from './state.ts';

/**
 * Messages passed inside the extension, popup or content script to the service
 * worker (plan section 9).
 *
 * The content script never speaks to the native host. It has the weakest trust
 * of any part of the extension - it runs in a page's world - so the worker is
 * the single place that decides what reaches the host, and it is a closed set of
 * intents rather than a passthrough for native message types.
 */
/** What the active tab is showing, when it looks printable. */
export interface ActiveTabPdf {
  /** Shown to the user, so they can see which document is meant. */
  name: string;
  url: string;
}

export type ExtensionRequest =
  | { kind: 'GET_HOST_STATE' }
  | { kind: 'GET_ACTIVE_TAB' }
  | { kind: 'PING_HOST' }
  | { kind: 'LIST_PRINTERS' }
  | { kind: 'GET_CONFIG' }
  | { kind: 'SET_CONFIG'; patch: ConfigPatch }
  | { kind: 'PRINT_TEST' }
  | { kind: 'LIST_DETECTED' }
  | { kind: 'PRINT_DETECTED'; downloadId: number }
  | { kind: 'DISMISS_DETECTED'; downloadId: number }
  /**
   * Print the PDF the active tab is showing.
   *
   * Carries NO url. The worker resolves the active tab itself, so there is no
   * address from a caller to validate and nothing a page could nominate. The
   * native host still has to recognise the document as a Booksy receipt.
   */
  | { kind: 'PRINT_ACTIVE_TAB' }
  /**
   * Look for a newer release, and fetch it.
   *
   * Writing intents even though a check changes nothing locally: it reaches the
   * network, and AC19 means that must never happen without the user asking.
   */
  | { kind: 'CHECK_UPDATE' }
  | { kind: 'DOWNLOAD_UPDATE' };

export type ExtensionResponse =
  | { kind: 'HOST_STATE'; state: HostState }
  | { kind: 'PRINTERS'; printers: Printer[]; adapter: string }
  | { kind: 'CONFIG'; config: BridgeConfig; present: boolean; error?: string }
  | { kind: 'PRINTED'; data: PrintTestData }
  | { kind: 'PRINTED_RECEIPT'; data: PrintReceiptData }
  | { kind: 'ACTIVE_TAB'; pdf: ActiveTabPdf | null; reason?: string }
  | { kind: 'UPDATE'; check: UpdateCheck }
  | { kind: 'UPDATE_DOWNLOADED'; download: UpdateDownload }
  | { kind: 'DETECTED'; receipts: DetectedReceipt[] }
  | { kind: 'ERROR'; message: string };

/**
 * Intents that change something.
 *
 * Only extension pages may send these. A content script gets the read-only
 * subset: it runs alongside a web page, and nothing in a page should be able to
 * repoint the printer or start a print job.
 */
export const WRITING_KINDS: ExtensionRequest['kind'][] = [
  'SET_CONFIG',
  'PRINT_TEST',
  'PRINT_DETECTED',
  'DISMISS_DETECTED',
  'PRINT_ACTIVE_TAB',
  'CHECK_UPDATE',
  'DOWNLOAD_UPDATE',
];

const READING_KINDS: ExtensionRequest['kind'][] = [
  'GET_HOST_STATE',
  'GET_ACTIVE_TAB',
  'PING_HOST',
  'LIST_PRINTERS',
  'GET_CONFIG',
  'LIST_DETECTED',
];

/** Validate an inbound internal message; the worker trusts nothing by shape. */
export function parseExtensionRequest(raw: unknown): ExtensionRequest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind !== 'string') return undefined;

  if (READING_KINDS.includes(kind as ExtensionRequest['kind'])) {
    return { kind } as ExtensionRequest;
  }
  if (kind === 'PRINT_TEST') return { kind };
  if (kind === 'SET_CONFIG') {
    const patch = parseConfigPatch(record['patch']);
    return patch === undefined ? undefined : { kind, patch };
  }
  if (kind === 'PRINT_ACTIVE_TAB' || kind === 'CHECK_UPDATE' || kind === 'DOWNLOAD_UPDATE') {
    return { kind };
  }
  if (kind === 'PRINT_DETECTED' || kind === 'DISMISS_DETECTED') {
    const downloadId = record['downloadId'];
    // An id, not a path: the caller names a receipt the worker already found,
    // so nothing in a page can nominate a file to open.
    if (typeof downloadId !== 'number' || !Number.isInteger(downloadId)) return undefined;
    return { kind, downloadId };
  }
  return undefined;
}

/**
 * Narrow a configuration patch to known keys and types.
 *
 * The host validates again with Zod - it must, since it cannot trust its own
 * stdin - so this is defence in depth rather than the only check. It exists so
 * a malformed patch is refused before a native process is started for it.
 */
export function parseConfigPatch(raw: unknown): ConfigPatch | undefined {
  if (!isPlainObject(raw)) return undefined;
  const record = raw;
  const patch: ConfigPatch = {};

  const printer = record['printer'];
  if (printer !== undefined) {
    if (!isPlainObject(printer)) return undefined;
    const source = printer;
    const target: NonNullable<ConfigPatch['printer']> = {};
    if (!assignString(source, target, 'name')) return undefined;
    for (const key of ['paperWidth', 'printableWidth', 'columns'] as const) {
      if (!assignNumber(source, target, key)) return undefined;
    }
    patch.printer = target;
  }

  const printing = record['printing'];
  if (printing !== undefined) {
    if (!isPlainObject(printing)) return undefined;
    const source = printing;
    const target: NonNullable<ConfigPatch['printing']> = {};
    for (const key of ['autoPrint', 'showPreview'] as const) {
      if (!assignBoolean(source, target, key)) return undefined;
    }
    if (!assignNumber(source, target, 'confidenceThreshold')) return undefined;
    const dirs = source['allowedDirs'];
    if (dirs !== undefined) {
      if (!Array.isArray(dirs) || dirs.some((entry) => typeof entry !== 'string')) return undefined;
      target.allowedDirs = dirs as string[];
    }
    patch.printing = target;
  }

  return patch;
}

/**
 * A configuration section, not an array.
 *
 * `typeof [] === 'object'`, so a bare typeof check lets an array through and it
 * comes out as an empty section rather than a refusal.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assignString<K extends string, T extends Partial<Record<K, string>>>(
  source: Record<string, unknown>,
  target: T,
  key: K,
): boolean {
  const value = source[key];
  if (value === undefined) return true;
  if (typeof value !== 'string') return false;
  target[key] = value as T[K];
  return true;
}

function assignNumber<K extends string, T extends Partial<Record<K, number>>>(
  source: Record<string, unknown>,
  target: T,
  key: K,
): boolean {
  const value = source[key];
  if (value === undefined) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  target[key] = value as T[K];
  return true;
}

function assignBoolean<K extends string, T extends Partial<Record<K, boolean>>>(
  source: Record<string, unknown>,
  target: T,
  key: K,
): boolean {
  const value = source[key];
  if (value === undefined) return true;
  if (typeof value !== 'boolean') return false;
  target[key] = value as T[K];
  return true;
}

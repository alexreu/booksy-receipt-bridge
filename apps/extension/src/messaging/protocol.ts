import type {
  BridgeConfig,
  RenderedReceipt,
  UpdateCheck,
  UpdateDownload,
  ConfigPatch,
  Printer,
  PrintReceiptData,
} from '@brb/shared';
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

/**
 * Where a preview's bytes come from.
 *
 * One case, and it carries no address: the worker reads the active tab itself.
 * Nothing a caller sends names the document that will be printed.
 */
export type PreviewSource = { kind: 'activeTab' };

export type ExtensionRequest =
  | { kind: 'GET_HOST_STATE' }
  | { kind: 'GET_ACTIVE_TAB' }
  | { kind: 'PING_HOST' }
  | { kind: 'LIST_PRINTERS' }
  | { kind: 'GET_CONFIG' }
  | { kind: 'SET_CONFIG'; patch: ConfigPatch }
  /**
   * Look for a newer release, and fetch it.
   *
   * Writing intents even though a check changes nothing locally: it reaches the
   * network, and AC19 means that must never happen without the user asking.
   */
  | { kind: 'CHECK_UPDATE' }
  | { kind: 'DOWNLOAD_UPDATE' }
  /**
   * Capture a receipt for approval, then render and print the captured bytes.
   *
   * The caller names a source once; afterwards it only ever passes the id back.
   * What was previewed is therefore exactly what is printed.
   */
  | { kind: 'PREPARE_PREVIEW'; source: PreviewSource }
  | { kind: 'RENDER_PREVIEW'; id: string }
  | { kind: 'PRINT_PREVIEW'; id: string; printerName?: string }
  | { kind: 'DISCARD_PREVIEW'; id: string };

export type ExtensionResponse =
  | { kind: 'HOST_STATE'; state: HostState }
  | { kind: 'PRINTERS'; printers: Printer[]; adapter: string }
  | { kind: 'CONFIG'; config: BridgeConfig; present: boolean; error?: string }
  | { kind: 'PRINTED_RECEIPT'; data: PrintReceiptData }
  | { kind: 'ACTIVE_TAB'; pdf: ActiveTabPdf | null; reason?: string }
  | { kind: 'PREVIEW_READY'; id: string; label?: string }
  | { kind: 'PREVIEW'; rendered: RenderedReceipt; label?: string }
  | { kind: 'UPDATE'; check: UpdateCheck }
  | { kind: 'UPDATE_DOWNLOADED'; download: UpdateDownload }
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
  'CHECK_UPDATE',
  'DOWNLOAD_UPDATE',
  'PREPARE_PREVIEW',
  'PRINT_PREVIEW',
];

/**
 * Intents a page's content script may send - the ALLOWLIST.
 *
 * Default-deny, so an intent added later is refused to pages until it is
 * listed here on purpose. The earlier rule was a denylist, which silently
 * granted every new intent to any page.
 *
 * These carry no argument and reveal nothing a page does not already know:
 * whether the service is up, what it can do, which printers exist.
 */
export const PAGE_ALLOWED_KINDS: ExtensionRequest['kind'][] = [
  'GET_HOST_STATE',
  'GET_ACTIVE_TAB',
  'PING_HOST',
  'LIST_PRINTERS',
  'GET_CONFIG',
];

/** Bare intents: no payload to validate. */
const BARE_KINDS: ExtensionRequest['kind'][] = [
  ...PAGE_ALLOWED_KINDS,
  'CHECK_UPDATE',
  'DOWNLOAD_UPDATE',
];

function parsePreviewSource(raw: unknown): PreviewSource | undefined {
  if (!isPlainObject(raw)) return undefined;
  return raw['kind'] === 'activeTab' ? { kind: 'activeTab' } : undefined;
}

/** Validate an inbound internal message; the worker trusts nothing by shape. */
export function parseExtensionRequest(raw: unknown): ExtensionRequest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind !== 'string') return undefined;

  if (BARE_KINDS.includes(kind as ExtensionRequest['kind'])) {
    return { kind } as ExtensionRequest;
  }
  if (kind === 'SET_CONFIG') {
    const patch = parseConfigPatch(record['patch']);
    return patch === undefined ? undefined : { kind, patch };
  }
  if (kind === 'PREPARE_PREVIEW') {
    const source = parsePreviewSource(record['source']);
    return source === undefined ? undefined : { kind, source };
  }
  if (kind === 'RENDER_PREVIEW' || kind === 'DISCARD_PREVIEW' || kind === 'PRINT_PREVIEW') {
    const id = record['id'];
    if (typeof id !== 'string' || id === '') return undefined;
    if (kind !== 'PRINT_PREVIEW') return { kind, id };

    const printerName = record['printerName'];
    if (printerName !== undefined && typeof printerName !== 'string') return undefined;
    return { kind, id, ...(printerName === undefined ? {} : { printerName }) };
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

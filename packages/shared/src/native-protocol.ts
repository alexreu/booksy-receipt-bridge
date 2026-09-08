/**
 * Native Messaging protocol types and constants (plan sections 13, 14).
 *
 * DELIBERATELY FREE OF ZOD. The extension needs these types and a couple of
 * numbers; validation is the host's job (plan section 44). Importing the schemas
 * from here would pull the whole validator into the extension bundle - it was
 * 90 kB of it before this split - for code that never runs in the browser.
 * The schemas live in `@brb/shared/schemas`, and a type-level test keeps the two
 * from drifting apart.
 */
import type { NativeError } from './errors.ts';
import type { ParseWarning } from './receipt.ts';

/**
 * Chrome caps a single host -> extension message at 1 MB and drops anything
 * larger with no error on either side, so the host checks before writing.
 */
export const MAX_RESPONSE_BYTES = 1_000_000;

/** Bumped on any breaking protocol change; the extension compares against it. */
export const PROTOCOL_VERSION = 1;

/**
 * How the host obtains the PDF.
 *
 * `path` is the preferred route (plan section 22): the download detector hands
 * over a local path and the host opens the file itself, so no PDF crosses the
 * messaging channel. `bytes` exists because the injected Booksy button has no
 * local file - it fetches the PDF with the page session and only ever holds an
 * ArrayBuffer.
 */
export type ReceiptSource =
  | { kind: 'path'; path: string }
  | { kind: 'bytes'; base64: string };

export interface ConfigPatch {
  printer?: {
    name?: string;
    paperWidth?: number;
    printableWidth?: number;
    columns?: number;
  };
  update?: {
    repo?: string;
    token?: string;
  };
  printing?: {
    autoPrint?: boolean;
    showPreview?: boolean;
    confidenceThreshold?: number;
    allowedDirs?: string[];
  };
}

export type NativeMessage =
  | { id: string; type: 'PING' }
  | { id: string; type: 'GET_STATUS' }
  | { id: string; type: 'LIST_PRINTERS' }
  | { id: string; type: 'GET_CONFIG' }
  | { id: string; type: 'SET_CONFIG'; payload: ConfigPatch }
  | { id: string; type: 'PARSE_RECEIPT'; payload: { source: ReceiptSource } }
  | {
      id: string;
      type: 'RENDER_RECEIPT';
      payload: { source: ReceiptSource; format: 'html' | 'text' };
    }
  | {
      id: string;
      type: 'PRINT_RECEIPT';
      payload: {
        source: ReceiptSource;
        /** Guards against double prints (plan section 54). */
        dedupeKey?: string;
        /**
         * Who asked. `auto` makes the host enforce its confidence threshold and
         * refuse below it (plan section 34); `user` prints what was read and
         * reports the confidence alongside. The rule lives in the host because
         * the host owns the configuration (plan section 68).
         */
        trigger?: 'user' | 'auto';
      };
    }
  | { id: string; type: 'PRINT_TEST' }
  /**
   * Look for a newer release. User-initiated only - there is no timer and no
   * check at startup, so the host never contacts anything unprompted.
   */
  | { id: string; type: 'CHECK_UPDATE' }
  | { id: string; type: 'DOWNLOAD_UPDATE' };

export type NativeMessageType = NativeMessage['type'];

export const NATIVE_MESSAGE_TYPES = [
  'PING',
  'GET_STATUS',
  'LIST_PRINTERS',
  'GET_CONFIG',
  'SET_CONFIG',
  'PARSE_RECEIPT',
  'RENDER_RECEIPT',
  'PRINT_RECEIPT',
  'PRINT_TEST',
  'CHECK_UPDATE',
  'DOWNLOAD_UPDATE',
] as const satisfies readonly NativeMessageType[];

export interface NativeResponse<T = unknown> {
  id: string;
  success: boolean;
  data?: T;
  error?: NativeError;
}

/** A print queue as the platform reports it. */
export interface Printer {
  name: string;
  isDefault?: boolean;
  /** Driver-reported status, free-form. */
  status?: string;
}

/**
 * Host configuration (plan section 38).
 *
 * Declared here so the options page can be typed against it without importing
 * the host's Zod schema. `config.test.ts` asserts the two agree.
 */
export interface BridgeConfig {
  printer: {
    /** Empty until configured. No model is hardcoded (plan section 65). */
    name: string;
    paperWidth: number;
    printableWidth: number;
    columns: number;
  };
  /** Where updates are looked for (plan section 50). */
  update: {
    /** owner/name on GitHub. */
    repo: string;
    /** Read-only token. Required for a private repository, unused otherwise. */
    token: string;
  };
  printing: {
    autoPrint: boolean;
    showPreview: boolean;
    confidenceThreshold: number;
    /**
     * Extra directories a receipt may be read from, on top of the user's
     * Downloads folder (plan section 23). Empty by default.
     */
    allowedDirs: string[];
  };
}

/** `LIST_PRINTERS` reply. */
export interface ListPrintersData {
  printers: Printer[];
  /** Which implementation answered, e.g. "windows" or "mock". */
  adapter: string;
}

/** `GET_CONFIG` and `SET_CONFIG` reply. */
export interface ConfigData {
  config: BridgeConfig;
  present: boolean;
  error?: string;
}

/** `PRINT_TEST` reply. */
export interface PrintTestData {
  jobId?: string;
  bytesSent?: number;
  /** Characters the code page could not represent and had to substitute. */
  unmapped?: string[];
}

/** `PRINT_RECEIPT` reply. */
export interface PrintReceiptData extends PrintTestData {
  ticketNumber: string;
  confidence: number;
  warnings: ParseWarning[];
  /**
   * True when the job was suppressed because the same receipt was printed a
   * moment ago (plan section 54). Not an error: the caller asked twice and got
   * one ticket, which is the intended outcome.
   */
  duplicate?: boolean;
}

/** `CHECK_UPDATE` reply. */
export interface UpdateCheck {
  current: string;
  latest?: string;
  available: boolean;
  releaseUrl?: string;
  assetName?: string;
  assetBytes?: number;
  prerelease?: boolean;
  notes?: string;
  /** Why the check could not be made. Absent on success. */
  error?: string;
}

/** `DOWNLOAD_UPDATE` reply. */
export type UpdateDownload =
  | { ok: true; path: string; bytes: number; version: string }
  | { ok: false; error: string };

/** `PING` reply (plan section 15). */
export interface PingData {
  status: 'ready';
  version: string;
  protocolVersion: number;
}

/** `GET_STATUS` reply - drives the popup checklist (plan section 16). */
export interface StatusData {
  status: 'ready' | 'degraded';
  version: string;
  protocolVersion: number;
  printerConfigured: boolean;
  /** The configured printer's name, so the popup can show it (plan section 17). */
  printerName?: string;
  printerFound: boolean;
  configPresent: boolean;
  /**
   * Which printer implementation is wired in, e.g. "windows" or "mock".
   *
   * Reported so the popup can say plainly that printing is not real yet rather
   * than showing a green tick because a mock answered.
   */
  printerAdapter: string;
  /** Message types this host actually implements. */
  supported: NativeMessageType[];
}

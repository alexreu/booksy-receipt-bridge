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
  printing?: {
    autoPrint?: boolean;
    showPreview?: boolean;
    confidenceThreshold?: number;
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
      /** `dedupeKey` guards against double prints (plan section 54). */
      payload: { source: ReceiptSource; dedupeKey?: string };
    }
  | { id: string; type: 'PRINT_TEST' };

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
] as const satisfies readonly NativeMessageType[];

export interface NativeResponse<T = unknown> {
  id: string;
  success: boolean;
  data?: T;
  error?: NativeError;
}

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

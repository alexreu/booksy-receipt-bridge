import { z } from 'zod';
import { BRIDGE_ERROR_CODES } from './errors.ts';

/**
 * Native Messaging protocol (plan sections 13, 14, 44).
 *
 * Every inbound message is validated with Zod before dispatch. Unknown types are
 * rejected: the host never trusts its stdin.
 *
 * SIZE LIMIT: Chrome caps a single host -> extension message at 1 MB. Anything that
 * could grow (a rendered preview, a printer list, a decoded ticket) must be checked
 * against MAX_RESPONSE_BYTES before being written.
 */
export const MAX_RESPONSE_BYTES = 1_000_000;

/** Bumped on any breaking protocol change; the extension compares against it. */
export const PROTOCOL_VERSION = 1;

/**
 * How the host obtains the PDF.
 *
 * `path` is the preferred route (plan section 22): the download detector hands over
 * a local path and the host opens the file itself, so no PDF crosses the messaging
 * channel. `bytes` exists because the injected Booksy button has no local file - it
 * fetches the PDF with the page session and only ever holds an ArrayBuffer.
 */
export const ReceiptSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), path: z.string().min(1) }),
  z.object({ kind: z.literal('bytes'), base64: z.string().min(1) }),
]);
export type ReceiptSource = z.infer<typeof ReceiptSourceSchema>;

export const PrinterConfigPatchSchema = z.object({
  name: z.string().min(1).optional(),
  paperWidth: z.number().positive().optional(),
  printableWidth: z.number().positive().optional(),
  columns: z.number().int().positive().optional(),
});

export const PrintingConfigPatchSchema = z.object({
  autoPrint: z.boolean().optional(),
  showPreview: z.boolean().optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
});

export const ConfigPatchSchema = z.object({
  printer: PrinterConfigPatchSchema.optional(),
  printing: PrintingConfigPatchSchema.optional(),
});
export type ConfigPatch = z.infer<typeof ConfigPatchSchema>;

/** Payload shape per message type. `undefined` means "no payload". */
export const NativeMessageSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string().min(1), type: z.literal('PING') }),
  z.object({ id: z.string().min(1), type: z.literal('GET_STATUS') }),
  z.object({ id: z.string().min(1), type: z.literal('LIST_PRINTERS') }),
  z.object({ id: z.string().min(1), type: z.literal('GET_CONFIG') }),
  z.object({
    id: z.string().min(1),
    type: z.literal('SET_CONFIG'),
    payload: ConfigPatchSchema,
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('PARSE_RECEIPT'),
    payload: z.object({ source: ReceiptSourceSchema }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('RENDER_RECEIPT'),
    payload: z.object({ source: ReceiptSourceSchema, format: z.enum(['html', 'text']) }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('PRINT_RECEIPT'),
    payload: z.object({
      source: ReceiptSourceSchema,
      /** Guards against double prints (plan section 54). */
      dedupeKey: z.string().optional(),
    }),
  }),
  z.object({ id: z.string().min(1), type: z.literal('PRINT_TEST') }),
]);

export type NativeMessage = z.infer<typeof NativeMessageSchema>;
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

export const NativeErrorSchema = z.object({
  code: z.enum(BRIDGE_ERROR_CODES),
  message: z.string(),
  detail: z.string().optional(),
});

export interface NativeResponse<T = unknown> {
  id: string;
  success: boolean;
  data?: T;
  error?: z.infer<typeof NativeErrorSchema>;
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

/**
 * Parse a raw stdin value into a known message.
 *
 * Returns a discriminated result rather than throwing: a malformed message must
 * produce a NativeResponse with INVALID_MESSAGE, not crash the host.
 */
export function parseNativeMessage(
  raw: unknown,
): { ok: true; message: NativeMessage } | { ok: false; issues: string[] } {
  const result = NativeMessageSchema.safeParse(raw);
  if (result.success) return { ok: true, message: result.data };
  return {
    ok: false,
    issues: result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}

import { z } from 'zod';
import { BRIDGE_ERROR_CODES } from './errors.ts';

/**
 * Runtime validation for the native protocol (plan section 44).
 *
 * Separate entry point (`@brb/shared/schemas`) so the extension can use the
 * protocol types without bundling Zod: the host is the only side that validates
 * an untrusted stream. `schemas.test.ts` asserts at the type level that these
 * schemas and the hand-written types in `native-protocol.ts` describe the same
 * shapes, which is what makes the duplication safe.
 */

export const ReceiptSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), path: z.string().min(1) }),
  z.object({ kind: z.literal('bytes'), base64: z.string().min(1) }),
]);

export const ConfigPatchSchema = z.object({
  printer: z
    .object({
      name: z.string().optional(),
      paperWidth: z.number().positive().optional(),
      printableWidth: z.number().positive().optional(),
      columns: z.number().int().positive().optional(),
    })
    .optional(),
  printing: z
    .object({
      autoPrint: z.boolean().optional(),
      showPreview: z.boolean().optional(),
      confidenceThreshold: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

const id = z.string().min(1);

export const NativeMessageSchema = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('PING') }),
  z.object({ id, type: z.literal('GET_STATUS') }),
  z.object({ id, type: z.literal('LIST_PRINTERS') }),
  z.object({ id, type: z.literal('GET_CONFIG') }),
  z.object({ id, type: z.literal('SET_CONFIG'), payload: ConfigPatchSchema }),
  z.object({
    id,
    type: z.literal('PARSE_RECEIPT'),
    payload: z.object({ source: ReceiptSourceSchema }),
  }),
  z.object({
    id,
    type: z.literal('RENDER_RECEIPT'),
    payload: z.object({ source: ReceiptSourceSchema, format: z.enum(['html', 'text']) }),
  }),
  z.object({
    id,
    type: z.literal('PRINT_RECEIPT'),
    payload: z.object({ source: ReceiptSourceSchema, dedupeKey: z.string().optional() }),
  }),
  z.object({ id, type: z.literal('PRINT_TEST') }),
]);

export const NativeErrorSchema = z.object({
  code: z.enum(BRIDGE_ERROR_CODES),
  message: z.string(),
  detail: z.string().optional(),
});

export type ValidatedNativeMessage = z.infer<typeof NativeMessageSchema>;

/**
 * Parse a raw stdin value into a known message.
 *
 * Returns a discriminated result rather than throwing: a malformed message must
 * produce a NativeResponse with INVALID_MESSAGE, not crash the host.
 */
export function parseNativeMessage(
  raw: unknown,
): { ok: true; message: ValidatedNativeMessage } | { ok: false; issues: string[] } {
  const result = NativeMessageSchema.safeParse(raw);
  if (result.success) return { ok: true, message: result.data };
  return {
    ok: false,
    issues: result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}

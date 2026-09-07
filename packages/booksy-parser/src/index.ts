/**
 * Booksy receipt parser — PHASE 2, NOT IMPLEMENTED YET.
 *
 * This package is deliberately empty of logic. Writing a coordinate-based parser
 * against a guessed layout is how you get a parser that fits nothing: it has to
 * be built from a real Booksy PDF, inspected first with `pnpm inspect`.
 *
 * The intended surface, for reference:
 *
 *   isBooksyReceipt(items: PdfTextItem[]): boolean
 *   parseBooksyReceipt(buffer: Uint8Array): Promise<ParseResult>
 *
 * `ParseResult` (receipt / confidence / warnings) already lives in @brb/shared,
 * so callers can be typed against it before the parser exists.
 *
 * Constraints that apply when it is written:
 *  - label- and regex-driven, with X/Y proximity and line grouping; no absolute
 *    positions (plan section 61);
 *  - never recompute a fiscal value, only report a mismatch as a warning
 *    (section 31);
 *  - `confidence` gates auto-print, default threshold 0.90 (section 34).
 */
export type { ParseResult, ParseWarning, ParseWarningCode, Receipt } from '@brb/shared';

/** Confidence below which auto-print must refuse (plan section 34). */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.9;

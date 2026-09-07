/**
 * One positioned text run as pdf.js reports it (plan section 32, extended).
 *
 * COORDINATE SYSTEMS - this is the detail that breaks phase 2 if ignored.
 * PDF space has its origin at the BOTTOM-left of the page and y grows upwards.
 * Grouping text into visual lines is far easier with y growing downwards, so both
 * are kept: `y` is the raw pdf.js baseline, `yTop` is the distance from the top of
 * the page to the top edge of the run. Line grouping must use `yTop`.
 */
export interface PdfTextItem {
  text: string;
  /** Left edge, PDF units (1/72 inch), origin bottom-left. */
  x: number;
  /** Baseline, PDF units, measured from the BOTTOM of the page. */
  y: number;
  /** Top edge, PDF units, measured from the TOP of the page. Use this to group lines. */
  yTop: number;
  width: number;
  height: number;
  /** 1-based. */
  page: number;
  fontName?: string;
  /** pdf.js signalled an end-of-line after this run. */
  hasEOL?: boolean;
  /**
   * Synthetic run carrying only whitespace. pdf.js emits these to represent the
   * horizontal gap between two runs on the same line; `x` and `width` measure the
   * gap. They carry no text and are skipped by groupIntoLines by default.
   */
  isWhitespace?: boolean;
}

export interface PdfPageInfo {
  page: number;
  width: number;
  height: number;
  /** Degrees, as declared by the page. */
  rotation: number;
  itemCount: number;
}

export interface PdfInspection {
  pageCount: number;
  pages: PdfPageInfo[];
  items: PdfTextItem[];
  /** True when no page yielded a single text run - almost certainly a scan. */
  looksLikeScan: boolean;
}

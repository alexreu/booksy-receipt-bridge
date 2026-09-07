import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { PdfInspection, PdfPageInfo, PdfTextItem } from './types.ts';

const require_ = createRequire(import.meta.url);

/** Directory of the installed pdfjs-dist package, for its font and cmap assets. */
function pdfjsAssetRoot(): string {
  return dirname(require_.resolve('pdfjs-dist/package.json'));
}

/**
 * Extract every positioned text run from a PDF.
 *
 * Uses the `legacy` build: it is the one that runs on plain Node with no DOM and
 * no worker, which is what the native host will be once bundled into a single
 * executable.
 *
 * The asset URLs are local directories rather than a CDN, deliberately: nothing
 * in this project may reach the network (AC19), and the bundled host will not
 * have one. They are passed as paths so a future single-file build only has to
 * ship those directories alongside the executable.
 *
 * `verbosity: 0` limits pdf.js to errors. It logs to stderr, which is the native
 * host's own log channel, so a chatty PDF would otherwise pollute the log.
 */
export async function inspectPdf(data: Uint8Array): Promise<PdfInspection> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const assets = pdfjsAssetRoot();

  const doc = await pdfjs.getDocument({
    // pdf.js transfers ownership of the buffer, so hand it a private copy.
    data: new Uint8Array(data),
    verbosity: 0,
    useSystemFonts: false,
    standardFontDataUrl: join(assets, 'standard_fonts/'),
    cMapUrl: join(assets, 'cmaps/'),
    cMapPacked: true,
    wasmUrl: join(assets, 'wasm/'),
  }).promise;

  try {
    const items: PdfTextItem[] = [];
    const pages: PdfPageInfo[] = [];

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();

      let itemCount = 0;
      for (const raw of textContent.items) {
        if (!('str' in raw)) continue; // marked-content markers carry no text
        if (raw.str === '') continue;

        const x = raw.transform[4] ?? 0;
        const y = raw.transform[5] ?? 0;

        // pdf.js synthesises whitespace-only runs to represent the horizontal gap
        // between two runs on the same line, and reports height 0 for them. Taking
        // that 0 at face value shifts their yTop by one font size and pushes them
        // onto a line of their own, which then breaks line grouping. Recover the
        // glyph height from the text matrix instead: for an unrotated run the font
        // size is the norm of its first column.
        const fontSize = Math.hypot(raw.transform[0] ?? 0, raw.transform[1] ?? 0);
        const height = raw.height > 0 ? raw.height : fontSize;
        const isWhitespace = raw.str.trim() === '';

        items.push({
          text: raw.str,
          x: round(x),
          y: round(y),
          yTop: round(viewport.height - (y + height)),
          width: round(raw.width),
          height: round(height),
          page: pageNumber,
          ...(raw.fontName ? { fontName: raw.fontName } : {}),
          ...(raw.hasEOL ? { hasEOL: true } : {}),
          ...(isWhitespace ? { isWhitespace: true } : {}),
        });
        itemCount++;
      }

      pages.push({
        page: pageNumber,
        width: round(viewport.width),
        height: round(viewport.height),
        rotation: page.rotate,
        itemCount,
      });

      page.cleanup();
    }

    return {
      pageCount: doc.numPages,
      pages,
      items,
      looksLikeScan: items.length === 0,
    };
  } finally {
    await doc.destroy();
  }
}

/** Two decimals is well below the precision that matters for line grouping. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Group runs into visual lines by vertical proximity.
 *
 * Exposed here (rather than in the parser) because it is the first thing anyone
 * reads a Booksy PDF with. `tolerance` is in PDF units: runs whose `yTop` differ
 * by less than that are on the same line, then sorted left to right.
 */
export interface GroupIntoLinesOptions {
  /** Runs whose yTop differ by less than this are on the same line. PDF units. */
  tolerance?: number;
  /**
   * Keep the synthetic whitespace runs pdf.js emits between columns. Off by
   * default because they add nothing to the text; a column-aware parser may want
   * them, since their x and width measure the gap exactly.
   */
  includeWhitespace?: boolean;
}

export function groupIntoLines(
  items: readonly PdfTextItem[],
  options: GroupIntoLinesOptions | number = {},
): PdfTextItem[][] {
  const { tolerance = 2, includeWhitespace = false } =
    typeof options === 'number' ? { tolerance: options } : options;

  const byPage = new Map<number, PdfTextItem[]>();
  for (const item of items) {
    if (!includeWhitespace && item.isWhitespace === true) continue;
    const bucket = byPage.get(item.page);
    if (bucket) bucket.push(item);
    else byPage.set(item.page, [item]);
  }

  const lines: PdfTextItem[][] = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const pageItems = [...(byPage.get(page) ?? [])].sort((a, b) => a.yTop - b.yTop);
    let current: PdfTextItem[] = [];
    let anchor = Number.NaN;

    for (const item of pageItems) {
      if (current.length === 0 || Math.abs(item.yTop - anchor) <= tolerance) {
        if (current.length === 0) anchor = item.yTop;
        current.push(item);
      } else {
        lines.push(current.sort((a, b) => a.x - b.x));
        current = [item];
        anchor = item.yTop;
      }
    }
    if (current.length > 0) lines.push(current.sort((a, b) => a.x - b.x));
  }
  return lines;
}

/** Flatten grouped lines to plain text, one string per visual line. */
export function linesToText(lines: readonly PdfTextItem[][]): string[] {
  return lines.map((line) =>
    line
      .map((item) => item.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

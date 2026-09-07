import type { TicketLayout, TicketStyle } from '@brb/ticket-layout';
import { renderTicketLines } from '@brb/ticket-layout';
import { CP858_SELECTOR, encodeCp858 } from './codepage.ts';
import { INIT, LF, align, bold, cut, feed, selectCodePage, size } from './commands.ts';

export interface EmitEscPosOptions {
  /** Dots to feed before cutting, so the cut clears the last printed row. */
  cutFeedDots?: number;
}

export interface EscPosOutput {
  bytes: Uint8Array;
  /** Characters that had no CP858 byte and were substituted. */
  unmapped: string[];
}

/**
 * Serialise a layout to ESC/POS.
 *
 * Alignment is done with spaces by the layout layer rather than with `ESC a`,
 * deliberately: the plain-text rendering and the printed output then come from
 * the same character rows and cannot disagree. `ESC a 0` is still emitted once
 * so the printer starts from a known state whatever the previous job left.
 */
export function emitEscPos(
  layout: TicketLayout,
  options: EmitEscPosOptions = {},
): EscPosOutput {
  const bytes: number[] = [];
  const unmapped: string[] = [];

  const noteUnmapped = (chars: readonly string[]): void => {
    for (const char of chars) if (!unmapped.includes(char)) unmapped.push(char);
  };

  const writeText = (text: string): void => {
    const encoded = encodeCp858(text);
    bytes.push(...encoded.bytes);
    noteUnmapped(encoded.unmapped);
  };

  bytes.push(...INIT, ...selectCodePage(CP858_SELECTOR), ...align(0));

  let currentStyle: TicketStyle = {};
  const applyStyle = (style: TicketStyle): void => {
    if ((style.bold ?? false) !== (currentStyle.bold ?? false)) {
      bytes.push(...bold(style.bold ?? false));
    }
    const width = style.doubleWidth === true ? 2 : 1;
    const height = style.doubleHeight === true ? 2 : 1;
    const currentWidth = currentStyle.doubleWidth === true ? 2 : 1;
    const currentHeight = currentStyle.doubleHeight === true ? 2 : 1;
    if (width !== currentWidth || height !== currentHeight) {
      bytes.push(...size(width, height));
    }
    currentStyle = style;
  };

  for (const line of renderTicketLines(layout)) {
    if (line.kind === 'text') {
      applyStyle(line.style ?? {});
      for (const row of line.rows) {
        writeText(row);
        bytes.push(LF);
      }
      continue;
    }
    if (line.kind === 'feed') {
      applyStyle({});
      if (line.rows > 0) bytes.push(...feed(line.rows));
      continue;
    }
    applyStyle({});
    bytes.push(...cut(options.cutFeedDots ?? 0));
  }

  return { bytes: new Uint8Array(bytes), unmapped };
}

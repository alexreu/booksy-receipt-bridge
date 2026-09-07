import type { TicketLayout, TicketLine, TicketStyle } from './types.ts';
import { effectiveColumns } from './types.ts';

/**
 * Word-wrap to `width` columns. A token longer than the line is hard-split rather
 * than truncated: losing characters from a service label or an NF525 signature is
 * exactly the failure this project exists to fix.
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];

  // Leading spaces are meaningful on a ticket - they indent an item's detail line
  // under its label. Collapsing them away (as a naive whitespace normalisation
  // does) makes a wrapped line jump left relative to its unwrapped neighbours.
  const indent = Math.min(/^[ \t]*/.exec(text)?.[0].length ?? 0, Math.max(0, width - 1));
  const body = wrapCore(text, width - indent);
  if (indent === 0) return body;
  const pad = ' '.repeat(indent);
  return body.map((line) => (line === '' ? '' : `${pad}${line}`));
}

function wrapCore(text: string, width: number): string[] {
  const normalised = text.replace(/\s+/g, ' ').trim();
  if (normalised === '') return [''];

  const out: string[] = [];
  let line = '';

  for (const word of normalised.split(' ')) {
    let token = word;
    // Hard-split anything that cannot fit on a line of its own.
    while (token.length > width) {
      if (line !== '') {
        out.push(line);
        line = '';
      }
      out.push(token.slice(0, width));
      token = token.slice(width);
    }
    if (line === '') line = token;
    else if (line.length + 1 + token.length <= width) line = `${line} ${token}`;
    else {
      out.push(line);
      line = token;
    }
  }
  if (line !== '') out.push(line);
  return out;
}

/** Left text and right text on one line, separated by padding. */
export function twoColumns(left: string, right: string, width: number): string {
  const gap = width - left.length - right.length;
  if (gap >= 1) return `${left}${' '.repeat(gap)}${right}`;
  // Caller is responsible for wrapping; this is the last-resort single line.
  return `${left} ${right}`.slice(0, width);
}

export function alignText(text: string, width: number, align: 'left' | 'center' | 'right'): string {
  if (text.length >= width) return text;
  const slack = width - text.length;
  if (align === 'right') return `${' '.repeat(slack)}${text}`;
  if (align === 'center') return `${' '.repeat(Math.floor(slack / 2))}${text}`;
  return text;
}

/**
 * One layout line resolved to the exact character rows it will occupy.
 *
 * Both the ESC/POS emitter and the plain-text renderer consume this, so what the
 * snapshot shows and what the printer receives cannot drift apart.
 */
export type RenderedLine =
  | { kind: 'text'; rows: string[]; style?: TicketStyle }
  | { kind: 'feed'; rows: number }
  | { kind: 'cut' };

export function renderTicketLine(line: TicketLine, columns: number): RenderedLine {
  switch (line.kind) {
    case 'text': {
      const width = effectiveColumns(columns, line.style);
      const rows = wrap(line.text, width).map((fragment) =>
        alignText(fragment, width, line.align ?? 'left'),
      );
      return { kind: 'text', rows, ...(line.style ? { style: line.style } : {}) };
    }
    case 'two-col': {
      const width = effectiveColumns(columns, line.style);
      const style = line.style ? { style: line.style } : {};

      if (line.left.length + line.right.length + 1 <= width) {
        return { kind: 'text', rows: [twoColumns(line.left, line.right, width)], ...style };
      }
      // Not enough room side by side: stack the label, then right-align the value.
      const leftRows = wrap(line.left, width);
      const last = leftRows[leftRows.length - 1] ?? '';
      if (last.length + line.right.length + 1 <= width) {
        return {
          kind: 'text',
          rows: [...leftRows.slice(0, -1), twoColumns(last, line.right, width)],
          ...style,
        };
      }
      // The value gets its own row(s). It must be wrapped too: a value longer
      // than the grid (a long customer name, say) would otherwise overflow.
      return {
        kind: 'text',
        rows: [
          ...leftRows,
          ...wrap(line.right, width).map((fragment) => alignText(fragment, width, 'right')),
        ],
        ...style,
      };
    }
    case 'separator':
      return { kind: 'text', rows: [(line.char ?? '-').repeat(columns)] };
    case 'feed':
      return { kind: 'feed', rows: line.lines };
    case 'cut':
      return { kind: 'cut' };
  }
}

export function renderTicketLines(layout: TicketLayout): RenderedLine[] {
  return layout.lines.map((line) => renderTicketLine(line, layout.columns));
}

/**
 * Render a layout to plain monospace rows.
 *
 * This is the canonical geometry of a ticket: the ESC/POS emitter, the HTML
 * preview and the test snapshots all agree with it by construction.
 */
export function layoutToLines(layout: TicketLayout): string[] {
  const out: string[] = [];
  for (const rendered of renderTicketLines(layout)) {
    if (rendered.kind === 'text') out.push(...rendered.rows);
    else if (rendered.kind === 'feed') {
      for (let i = 0; i < rendered.rows; i++) out.push('');
    }
  }
  return out;
}

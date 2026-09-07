import { describe, expect, it } from 'vitest';
import {
  buildTicketLayout,
  layoutToLines,
  minimalReceipt,
  nominalReceipt,
  stressReceipt,
} from '@brb/ticket-layout';
import { ESC, GS } from './commands.ts';
import { emitEscPos } from './emit.ts';
import { decodeEscPos, decodeToSvg, decodeToText } from './decode.ts';

const CUT_MARKER = /^%+ CUT %+$/;

function withoutCutMarker(text: string): string {
  return text
    .split('\n')
    .filter((line) => !CUT_MARKER.test(line))
    .join('\n');
}

describe('emitEscPos', () => {
  it('starts with a reset and a code page selection', () => {
    const { bytes } = emitEscPos(buildTicketLayout(minimalReceipt()));
    expect([...bytes.slice(0, 5)]).toEqual([ESC, 0x40, ESC, 0x74, 19]);
  });

  it('ends with a cut', () => {
    const { bytes } = emitEscPos(buildTicketLayout(minimalReceipt()));
    expect([...bytes.slice(-4)]).toEqual([GS, 0x56, 66, 0]);
  });

  it('feeds before cutting when asked', () => {
    const { bytes } = emitEscPos(buildTicketLayout(minimalReceipt()), { cutFeedDots: 40 });
    expect([...bytes.slice(-4)]).toEqual([GS, 0x56, 66, 40]);
  });

  it('reports the characters it had to substitute', () => {
    // The stress fixture carries a typographic apostrophe.
    const { unmapped } = emitEscPos(buildTicketLayout(stressReceipt()));
    expect(unmapped).toEqual(['’']);
  });

  it('substitutes nothing on a receipt made of CP858 characters', () => {
    const { unmapped } = emitEscPos(buildTicketLayout(nominalReceipt()));
    expect(unmapped).toEqual([]);
  });

  it('emits no bare high byte that the printer would misread', () => {
    // Every byte >= 0x80 must be inside a CP858 text run, never a stray command
    // argument, otherwise the printer prints a random glyph.
    const { bytes } = emitEscPos(buildTicketLayout(nominalReceipt()));
    const decoded = decodeEscPos(bytes);
    expect(decoded.unknownCommands).toEqual([]);
  });
});

describe('emit -> decode round trip', () => {
  // This is the core guarantee of the intermediate layout layer: the text a
  // snapshot shows and the bytes the printer receives describe the same ticket.
  it.each([
    ['nominal', nominalReceipt],
    ['stress', stressReceipt],
    ['minimal', minimalReceipt],
  ])('replays the %s ticket as the layout rendered it', (_name, make) => {
    const layout = buildTicketLayout(make());
    const { bytes } = emitEscPos(layout);

    const expected = layoutToLines(layout)
      .join('\n')
      // The emitter substitutes characters CP858 lacks, so compare against the
      // same substitution rather than against the original glyph.
      .replace(/’/g, "'");

    expect(withoutCutMarker(decodeToText(bytes))).toBe(expected);
  });

  it('preserves bold and double-size styling', () => {
    const layout = buildTicketLayout(nominalReceipt());
    const decoded = decodeEscPos(emitEscPos(layout).bytes);

    const merchantRow = decoded.rows.find((row) => row.text.includes('Salon Démo'));
    expect(merchantRow?.bold).toBe(true);
    expect(merchantRow?.heightMultiplier).toBe(2);

    const totalRow = decoded.rows.find((row) => row.text.startsWith('TOTAL TTC'));
    expect(totalRow?.bold).toBe(true);
    expect(totalRow?.heightMultiplier).toBe(1);
  });

  it('resets styling after a styled row', () => {
    const decoded = decodeEscPos(emitEscPos(buildTicketLayout(nominalReceipt())).bytes);
    const siretRow = decoded.rows.find((row) => row.text.includes('SIRET'));
    expect(siretRow?.bold).toBe(false);
    expect(siretRow?.heightMultiplier).toBe(1);
  });

  it('records the code page it saw', () => {
    const decoded = decodeEscPos(emitEscPos(buildTicketLayout(minimalReceipt())).bytes);
    expect(decoded.initialised).toBe(true);
    expect(decoded.codePage).toBe(19);
  });

  it('places the cut after the last row', () => {
    const layout = buildTicketLayout(minimalReceipt());
    const decoded = decodeEscPos(emitEscPos(layout).bytes);
    expect(decoded.cutAfterRow).toEqual([decoded.rows.length - 1]);
  });

  it('keeps every row inside the column grid', () => {
    // AC13 checked on the bytes rather than on the layout, so a bug in the
    // emitter cannot smuggle an over-wide row past the layout tests.
    for (const columns of [32, 42, 48]) {
      const layout = buildTicketLayout(stressReceipt(), { columns });
      const decoded = decodeEscPos(emitEscPos(layout).bytes);
      for (const row of decoded.rows) {
        expect(row.text.length * row.widthMultiplier).toBeLessThanOrEqual(columns);
      }
    }
  });
});

describe('decodeToSvg', () => {
  it('produces a self-contained SVG with the ticket text in it', () => {
    const { bytes } = emitEscPos(buildTicketLayout(nominalReceipt()));
    const svg = decodeToSvg(bytes);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('TOTAL TTC');
    expect(svg).toContain('stroke-dasharray'); // the cut line
  });

  it('escapes XML-significant characters', () => {
    const svg = decodeToSvg(emitEscPos({ columns: 42, lines: [{ kind: 'text', text: 'a<b&c' }] }).bytes);
    expect(svg).toContain('a&lt;b&amp;c');
  });
});

describe('snapshots', () => {
  it.each([
    ['nominal', nominalReceipt],
    ['stress', stressReceipt],
    ['minimal', minimalReceipt],
  ])('replays the %s ticket', (_name, make) => {
    const { bytes } = emitEscPos(buildTicketLayout(make()));
    expect(decodeToText(bytes)).toMatchSnapshot();
  });
});

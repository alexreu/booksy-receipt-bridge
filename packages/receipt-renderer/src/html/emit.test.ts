import { describe, expect, it } from 'vitest';
import {
  buildTicketLayout,
  layoutToLines,
  minimalReceipt,
  nominalReceipt,
  stressReceipt,
} from '@brb/ticket-layout';
import { emitHtml } from './emit.ts';

const SAMPLES = [
  ['nominal', nominalReceipt],
  ['stress', stressReceipt],
  ['minimal', minimalReceipt],
] as const;

/** The text of each rendered row, unescaped, in order. */
function htmlRows(html: string): string[] {
  return [...html.matchAll(/<div class="row">(?:<span[^>]*>)?([\s\S]*?)(?:<\/span>)?<\/div>/g)].map(
    (match) => unescapeHtml(match[1] ?? ''),
  );
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

describe('emitHtml - the preview shows what the printer receives', () => {
  // Both paths consume renderTicketLines, so this is a guard against anyone
  // giving the HTML its own idea of the layout.
  it.each(SAMPLES)('renders the %s ticket row for row', (_name, make) => {
    const layout = buildTicketLayout(make());
    expect(htmlRows(emitHtml(layout))).toEqual(layoutToLines(layout));
  });

  it('keeps the padding that aligns the columns', () => {
    const layout = buildTicketLayout(nominalReceipt());
    const total = htmlRows(emitHtml(layout)).find((row) => row.startsWith('TOTAL TTC'));
    expect(total).toMatch(/^TOTAL TTC {2,}44,00 €$/);
    expect(total).toHaveLength(42);
  });

  it('declares white-space: pre, without which that padding collapses', () => {
    expect(emitHtml(buildTicketLayout(minimalReceipt()))).toContain('white-space: pre');
  });
});

describe('emitHtml - document shell', () => {
  it('emits a standalone document', () => {
    const html = emitHtml(buildTicketLayout(nominalReceipt()), { title: 'Reçu 996' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Reçu 996</title>');
    expect(html).toContain('<style>');
  });

  it('emits only the ticket when asked for a fragment', () => {
    const html = emitHtml(buildTicketLayout(nominalReceipt()), { fragment: true });
    expect(html.startsWith('<div class="ticket">')).toBe(true);
    expect(html).not.toContain('<style>');
    expect(html).not.toContain('<!doctype');
  });

  it('loads nothing from the network - manifest V3 CSP and AC19', () => {
    const html = emitHtml(buildTicketLayout(stressReceipt()));
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('@import');
    expect(html).not.toContain('url(');
  });

  it('sets the page size to the paper width so no driver rescales it', () => {
    const html = emitHtml(buildTicketLayout(nominalReceipt()));
    expect(html).toContain('size: 80mm auto');
    expect(html).toContain('margin: 0');
    expect(html).toContain('width: 72mm');
  });

  it('honours a configured paper and printable width', () => {
    const html = emitHtml(buildTicketLayout(nominalReceipt()), {
      paperWidth: 58,
      printableWidth: 48,
    });
    expect(html).toContain('size: 58mm auto');
    expect(html).toContain('width: 48mm');
  });

  it('solves the font size so the column count spans the printable width', () => {
    // 72mm / 42 columns / 0.6 advance ratio = 2.857mm
    const html = emitHtml(buildTicketLayout(nominalReceipt(), { columns: 42 }), {
      printableWidth: 72,
    });
    expect(html).toContain('font-size: 2.857mm');
  });

  it('scales the font with a different column count', () => {
    const html = emitHtml(buildTicketLayout(nominalReceipt(), { columns: 56 }));
    expect(html).toContain('font-size: 2.143mm');
  });
});

describe('emitHtml - styling', () => {
  it('marks a bold row bold', () => {
    const html = emitHtml({
      columns: 42,
      lines: [{ kind: 'text', text: 'Gras', style: { bold: true } }],
    });
    expect(html).toContain('font-weight:700');
  });

  it('renders double height as tall and narrow, the way the printer does', () => {
    const html = emitHtml({
      columns: 42,
      lines: [{ kind: 'text', text: 'Haut', style: { doubleHeight: true } }],
    });
    expect(html).toContain('font-size:2em');
    expect(html).toContain('transform:scaleX(0.5)');
  });

  it('renders double width as wide and normal height', () => {
    const html = emitHtml({
      columns: 42,
      lines: [{ kind: 'text', text: 'Large', style: { doubleWidth: true } }],
    });
    expect(html).toContain('transform:scaleX(2)');
    expect(html).not.toContain('font-size:2em');
  });

  it('leaves an unstyled row without a span wrapper', () => {
    const html = emitHtml({ columns: 42, lines: [{ kind: 'text', text: 'Simple' }] });
    expect(html).toContain('<div class="row">Simple</div>');
  });

  it('renders the cut as a separator', () => {
    const html = emitHtml({ columns: 42, lines: [{ kind: 'cut' }] });
    expect(html).toContain('class="cut"');
    expect(html).toContain('aria-label="coupe papier"');
  });

  it('gives a feed its blank rows', () => {
    const html = emitHtml({ columns: 42, lines: [{ kind: 'feed', lines: 3 }] });
    expect(htmlRows(html)).toEqual(['', '', '']);
  });
});

describe('emitHtml - escaping', () => {
  it('escapes the characters that would break the markup', () => {
    const html = emitHtml({
      columns: 42,
      lines: [{ kind: 'text', text: 'a<b>&"c' }],
    });
    expect(html).toContain('a&lt;b&gt;&amp;&quot;c');
    expect(html).not.toContain('<b>');
  });

  it('escapes a label that tries to inject a script', () => {
    const html = emitHtml({
      columns: 42,
      lines: [{ kind: 'text', text: '<script>alert(1)</script>' }],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes the title', () => {
    const html = emitHtml({ columns: 42, lines: [] }, { title: '<img src=x>' });
    expect(html).toContain('<title>&lt;img src=x&gt;</title>');
  });
});

describe('emitHtml - the content cases the plan calls out', () => {
  it('wraps a long service name instead of truncating it', () => {
    const receipt = stressReceipt();
    const longLabel = receipt.items[0]?.label ?? '';
    expect(longLabel.length).toBeGreaterThan(42);

    const rows = htmlRows(emitHtml(buildTicketLayout(receipt)));
    expect(rows.join('').replace(/\s/g, '')).toContain(longLabel.replace(/\s/g, ''));
    expect(rows.every((row) => row.length <= 42)).toBe(true);
  });

  it('renders every item of a multi-item receipt', () => {
    const receipt = stressReceipt();
    const text = htmlRows(emitHtml(buildTicketLayout(receipt))).join('\n');
    expect(receipt.items).toHaveLength(4);
    for (const item of receipt.items) {
      expect(text.replace(/\s/g, '')).toContain(item.label.replace(/\s/g, ''));
    }
  });

  it('renders every VAT rate of a multi-rate receipt', () => {
    const text = htmlRows(emitHtml(buildTicketLayout(stressReceipt()))).join('\n');
    expect(text).toContain('20 %');
    expect(text).toContain('10 %');
    expect(text).toContain('5,50 %');
  });

  it('renders a long certification block in full', () => {
    const receipt = stressReceipt();
    const signature = receipt.certification?.signature ?? '';
    expect(signature.length).toBeGreaterThan(42);
    const packed = htmlRows(emitHtml(buildTicketLayout(receipt))).join('').replace(/\s/g, '');
    expect(packed).toContain(signature);
    expect(packed).toContain((receipt.certification?.certification ?? '').replace(/\s/g, ''));
  });

  it('renders every non-ASCII character the receipt contains', () => {
    // Derived from the fixture rather than a hardcoded list, so a fixture that
    // gains a new accent is covered without editing this test. Exhaustive
    // per-character coverage lives in the CP858 tests, which round-trip all 128
    // high bytes; here the point is that HTML emission loses none of them.
    const receipt = stressReceipt();
    const html = emitHtml(buildTicketLayout(receipt));
    const nonAscii = [...new Set([...JSON.stringify(receipt)])].filter(
      (char) => char.charCodeAt(0) > 127,
    );
    expect(nonAscii.length).toBeGreaterThan(5);
    for (const char of nonAscii) {
      expect(html, `missing ${char}`).toContain(char);
    }
  });

  it('renders the euro sign', () => {
    const html = emitHtml(buildTicketLayout(nominalReceipt()));
    expect(html).toContain('44,00 €');
  });
});

describe('emitHtml - snapshots', () => {
  it.each(SAMPLES)('renders the %s ticket', (_name, make) => {
    expect(emitHtml(buildTicketLayout(make()), { fragment: true })).toMatchSnapshot();
  });
});

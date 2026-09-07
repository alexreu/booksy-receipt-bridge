import { describe, expect, it } from 'vitest';
import type { Receipt } from '@brb/shared';
import { DEFAULT_COLUMNS, buildTicketLayout } from './build.ts';
import { formatRate } from './format.ts';
import { layoutToLines } from './text.ts';
import { minimalReceipt, nominalReceipt, stressReceipt } from './testing/sample-receipts.ts';

const WIDTHS = [32, 42, 48] as const;
const SAMPLES: Array<[string, () => Receipt]> = [
  ['nominal', nominalReceipt],
  ['stress', stressReceipt],
  ['minimal', minimalReceipt],
];

/** All ticket text with every space removed - see "nothing is cut" below. */
function packed(receipt: Receipt, columns: number): string {
  return layoutToLines(buildTicketLayout(receipt, { columns }))
    .join('')
    .replace(/\s/g, '');
}

function strip(value: string): string {
  return value.replace(/\s/g, '');
}

describe('buildTicketLayout - AC13, nothing important is cut', () => {
  // Wrapping is allowed, dropping characters is not. Comparing whitespace-free
  // forms lets a field match whether it wrapped on a space or was hard-split.
  it.each(SAMPLES)('keeps every text field of the %s receipt', (_name, make) => {
    const receipt = make();
    const output = packed(receipt, DEFAULT_COLUMNS);

    expect(output).toContain(strip(receipt.merchant.name));
    expect(output).toContain(strip(receipt.ticket.number));
    for (const line of receipt.merchant.address ?? []) {
      expect(output).toContain(strip(line));
    }
    for (const field of [
      receipt.merchant.siret,
      receipt.merchant.vatNumber,
      receipt.merchant.nafCode,
      receipt.customer?.name,
      receipt.customer?.id,
      receipt.ticket.operationType,
      receipt.payment?.method,
      receipt.certification?.software,
      receipt.certification?.softwareId,
      receipt.certification?.certification,
      receipt.certification?.signatureTimestamp,
      receipt.certification?.signature,
    ]) {
      if (field !== undefined) expect(output).toContain(strip(field));
    }
    for (const item of receipt.items) {
      expect(output).toContain(strip(item.label));
    }
  });

  it.each(SAMPLES)('keeps every amount of the %s receipt', (_name, make) => {
    const receipt = make();
    const output = packed(receipt, DEFAULT_COLUMNS);

    const amounts = [
      receipt.totals.totalTTC,
      receipt.totals.subtotal,
      receipt.payment?.amount,
      ...receipt.items.map((item) => item.total),
      ...receipt.vat.map((line) => line.amount),
      ...receipt.vat.map((line) => line.base),
    ];
    for (const amount of amounts) {
      if (amount === undefined) continue;
      expect(output).toContain(strip(`${amount.toFixed(2).replace('.', ',')}€`));
    }
  });

  it.each(SAMPLES)('keeps every VAT rate of the %s receipt', (_name, make) => {
    const receipt = make();
    const output = packed(receipt, DEFAULT_COLUMNS);
    for (const line of receipt.vat) {
      expect(output).toContain(strip(formatRate(line.rate)));
    }
  });
});

describe('buildTicketLayout - AC12, the grid is respected', () => {
  for (const columns of WIDTHS) {
    it.each(SAMPLES)(`fits the %s receipt in ${columns} columns`, (_name, make) => {
      const lines = layoutToLines(buildTicketLayout(make(), { columns }));
      const tooWide = lines.filter((line) => line.length > columns);
      expect(tooWide).toEqual([]);
    });
  }

  it('defaults to 42 columns for 80 mm Font A', () => {
    expect(DEFAULT_COLUMNS).toBe(42);
    expect(buildTicketLayout(nominalReceipt()).columns).toBe(42);
  });
});

describe('buildTicketLayout - structure', () => {
  it('ends with a feed and a cut so the ticket is detachable', () => {
    const { lines } = buildTicketLayout(nominalReceipt());
    expect(lines.at(-1)).toEqual({ kind: 'cut' });
    expect(lines.at(-2)).toEqual({ kind: 'feed', lines: 3 });
  });

  it('emits exactly one line per item plus its detail line', () => {
    const receipt = nominalReceipt();
    const { lines } = buildTicketLayout(receipt);
    for (const item of receipt.items) {
      expect(lines).toContainEqual({ kind: 'text', text: item.label });
    }
  });

  it('marks a reprint as a duplicate', () => {
    const plain = layoutToLines(buildTicketLayout(nominalReceipt())).join('\n');
    const reprint = layoutToLines(
      buildTicketLayout(nominalReceipt(), { duplicate: true }),
    ).join('\n');
    expect(plain).not.toContain('DUPLICATA');
    expect(reprint).toContain('DUPLICATA');
  });

  it('renders a negative amount without mangling the sign', () => {
    const output = layoutToLines(buildTicketLayout(stressReceipt())).join('\n');
    expect(output).toContain('-20,00 €');
  });

  it('renders one VAT line per rate', () => {
    const receipt = stressReceipt();
    const output = layoutToLines(buildTicketLayout(receipt)).join('\n');
    expect(receipt.vat).toHaveLength(3);
    expect(output).toContain('20 %');
    expect(output).toContain('10 %');
    expect(output).toContain('5,50 %');
  });

  it('omits absent optional sections', () => {
    const output = layoutToLines(buildTicketLayout(minimalReceipt())).join('\n');
    expect(output).not.toContain('SIRET');
    expect(output).not.toContain('Client');
    expect(output).not.toContain('Signature');
    expect(output).not.toContain('Sous-total');
    expect(output).toContain('TOTAL TTC');
  });

  it('never recomputes a total from the items', () => {
    // The fixture is deliberately inconsistent: the items sum to 44, but the
    // document claims 999. A cash register would object; a bridge prints what the
    // document says and lets the parser raise a warning.
    const receipt = nominalReceipt();
    receipt.totals.totalTTC = 999;
    const totalLine = layoutToLines(buildTicketLayout(receipt)).find((line) =>
      line.startsWith('TOTAL TTC'),
    );
    expect(totalLine).toContain('999,00 €');
  });
});

describe('buildTicketLayout - snapshots', () => {
  it.each(SAMPLES)('renders the %s receipt', (_name, make) => {
    expect(layoutToLines(buildTicketLayout(make())).join('\n')).toMatchSnapshot();
  });
});

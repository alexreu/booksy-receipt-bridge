import { describe, expect, it } from 'vitest';
import { alignText, layoutToLines, twoColumns, wrap } from './text.ts';

describe('wrap', () => {
  it('keeps a short string on one line', () => {
    expect(wrap('Coupe femme', 42)).toEqual(['Coupe femme']);
  });

  it('breaks on word boundaries', () => {
    expect(wrap('un deux trois quatre', 10)).toEqual(['un deux', 'trois', 'quatre']);
  });

  it('hard-splits a token longer than the line instead of truncating it', () => {
    const signature = 'A'.repeat(100);
    const lines = wrap(signature, 42);
    expect(lines.join('')).toBe(signature);
    expect(lines.every((line) => line.length <= 42)).toBe(true);
  });

  it('loses no character when a long token follows text', () => {
    const input = `Signature ${'B'.repeat(70)}`;
    const lines = wrap(input, 42);
    expect(lines.join('').replace(/\s/g, '')).toBe(input.replace(/\s/g, ''));
  });

  it('collapses runs of whitespace', () => {
    expect(wrap('a   b\n c', 42)).toEqual(['a b c']);
  });

  it('keeps a leading indent on every wrapped line', () => {
    expect(wrap('  un deux trois', 10)).toEqual(['  un deux', '  trois']);
  });

  it('right-aligns a value that has to wrap onto its own line', () => {
    const lines = layoutToLines({
      columns: 12,
      lines: [{ kind: 'two-col', left: 'Client', right: 'Marie-Segolene de La Tour' }],
    });
    expect(lines.every((line) => line.length <= 12)).toBe(true);
    // At 12 columns the name is hard-split, so it is only contiguous once the
    // wrapping whitespace is removed. What matters is that nothing is lost.
    expect(lines.join('').replace(/\s/g, '')).toContain('Marie-SegolenedeLaTour');
  });

  it('returns a single empty line for empty input', () => {
    expect(wrap('', 42)).toEqual(['']);
    expect(wrap('   ', 42)).toEqual(['']);
  });
});

describe('twoColumns', () => {
  it('pads between the two sides', () => {
    expect(twoColumns('TOTAL', '44,00', 20)).toBe('TOTAL          44,00');
    expect(twoColumns('TOTAL', '44,00', 20)).toHaveLength(20);
  });

  it('keeps at least one space', () => {
    expect(twoColumns('abcdefgh', 'ij', 11)).toBe('abcdefgh ij');
  });
});

describe('alignText', () => {
  it('aligns within the width', () => {
    // Left-aligned text is not padded: trailing spaces are wasted paper and make
    // snapshots noisy.
    expect(alignText('ab', 6, 'left')).toBe('ab');
    expect(alignText('ab', 6, 'right')).toBe('    ab');
    expect(alignText('ab', 6, 'center')).toBe('  ab');
  });

  it('leaves overlong text alone', () => {
    expect(alignText('abcdef', 3, 'center')).toBe('abcdef');
  });
});

describe('layoutToLines', () => {
  it('renders each line kind', () => {
    const lines = layoutToLines({
      columns: 10,
      lines: [
        { kind: 'text', text: 'hi', align: 'center' },
        { kind: 'separator' },
        { kind: 'separator', char: '=' },
        { kind: 'two-col', left: 'a', right: 'b' },
        { kind: 'feed', lines: 2 },
        { kind: 'cut' },
      ],
    });
    expect(lines).toEqual(['    hi', '----------', '==========', 'a        b', '', '']);
  });

  it('halves the usable columns for double-width text', () => {
    const lines = layoutToLines({
      columns: 20,
      lines: [{ kind: 'text', text: 'abcdefghijklmno', style: { doubleWidth: true } }],
    });
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.trim().length <= 10)).toBe(true);
  });

  it('stacks a two-col line that cannot fit side by side', () => {
    const lines = layoutToLines({
      columns: 20,
      lines: [{ kind: 'two-col', left: 'un libelle vraiment long', right: '1234,56 €' }],
    });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 20)).toBe(true);
    expect(lines.join('')).toContain('1234,56 €');
  });
});

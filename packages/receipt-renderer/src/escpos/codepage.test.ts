import { describe, expect, it } from 'vitest';
import { CP858_SELECTOR, decodeCp858, encodeCp858 } from './codepage.ts';

describe('encodeCp858', () => {
  it('selects the code page that actually has a euro glyph', () => {
    expect(CP858_SELECTOR).toBe(19);
  });

  // The characters the acceptance criteria name explicitly.
  it.each([
    ['é', 0x82],
    ['è', 0x8a],
    ['à', 0x85],
    ['ç', 0x87],
    ['ù', 0x97],
    ['°', 0xf8],
    ['€', 0xd5],
  ])('encodes %s', (char, byte) => {
    const { bytes, unmapped } = encodeCp858(char);
    expect([...bytes]).toEqual([byte]);
    expect(unmapped).toEqual([]);
  });

  it('encodes a full accented sentence with no substitution', () => {
    const text = 'Établissement à Nîmes : coût 12,50 € — TVA incluse';
    const { unmapped } = encodeCp858(text.replace('—', '-'));
    expect(unmapped).toEqual([]);
  });

  it('passes ASCII through unchanged', () => {
    const { bytes } = encodeCp858('TOTAL TTC 44,00');
    expect(Buffer.from(bytes).toString('ascii')).toBe('TOTAL TTC 44,00');
  });

  it('keeps line feeds', () => {
    expect([...encodeCp858('a\nb').bytes]).toEqual([0x61, 0x0a, 0x62]);
  });

  it('substitutes a bullet with a middle dot rather than a question mark', () => {
    // Real Booksy receipts use "Carte bancaire • 11/08/2026" in the payment
    // summary. CP858 has no bullet; 0xFA is a middle dot and reads correctly.
    const { bytes, unmapped } = encodeCp858('Carte bancaire \u2022 11/08');
    expect([...bytes].includes(0xfa)).toBe(true);
    expect([...bytes].includes(0x3f)).toBe(false);
    expect(unmapped).toEqual(['\u2022']);
  });

  it('substitutes a curly apostrophe and reports it', () => {
    // Booksy output contains typographic quotes; CP858 has none.
    const { bytes, unmapped } = encodeCp858('Tour-d’Auvergne');
    expect(Buffer.from(bytes).toString('ascii')).toBe("Tour-d'Auvergne");
    expect(unmapped).toEqual(['’']);
  });

  it('normalises a non-breaking space to a plain space, without reporting it', () => {
    // French puts a NBSP before the euro sign. CP858 does have a NBSP byte
    // (0xFF), but a plain 0x20 prints blank on any firmware.
    const { bytes, unmapped } = encodeCp858('12,50\u00a0€');
    expect([...bytes]).toEqual([0x31, 0x32, 0x2c, 0x35, 0x30, 0x20, 0xd5]);
    expect(unmapped).toEqual([]);
  });

  it('normalises the narrow no-break space too', () => {
    expect([...encodeCp858('5\u202f%').bytes]).toEqual([0x35, 0x20, 0x25]);
  });

  it('de-accents a character the page does not have', () => {
    const { bytes, unmapped } = encodeCp858('ẽ');
    expect(Buffer.from(bytes).toString('ascii')).toBe('e');
    expect(unmapped).toEqual(['ẽ']);
  });

  it('falls back to a question mark and reports it, never dropping the character', () => {
    const { bytes, unmapped } = encodeCp858('a漢b');
    expect(Buffer.from(bytes).toString('ascii')).toBe('a?b');
    expect(unmapped).toEqual(['漢']);
  });

  it('reports each unmapped character once', () => {
    const { unmapped } = encodeCp858('’’’漢漢');
    expect(unmapped).toEqual(['’', '漢']);
  });

  it('handles an emoji as one unit', () => {
    const { bytes, unmapped } = encodeCp858('a🖨b');
    expect(Buffer.from(bytes).toString('ascii')).toBe('a?b');
    expect(unmapped).toEqual(['🖨']);
  });
});

describe('decodeCp858', () => {
  it('is the inverse of encodeCp858 for mappable text', () => {
    const text = 'Établissement à Nîmes : coût 12,50 € TVA 5,50 % ° µ';
    const { bytes, unmapped } = encodeCp858(text);
    expect(unmapped).toEqual([]);
    expect(decodeCp858(bytes)).toBe(text);
  });

  it('maps every byte of the high range to a real character', () => {
    const high = new Uint8Array(128);
    for (let index = 0; index < 128; index++) high[index] = 0x80 + index;
    const decoded = decodeCp858(high);
    expect(decoded).toHaveLength(128);
    expect(decoded).not.toContain('\ufffd');
  });

  it('round-trips every high byte except the NBSP', () => {
    // 0xFF decodes to a NBSP, which the encoder deliberately normalises to a
    // plain space. That one asymmetry is intentional - see SPACE_VARIANTS.
    const high = new Uint8Array(127);
    for (let index = 0; index < 127; index++) high[index] = 0x80 + index;
    expect([...encodeCp858(decodeCp858(high)).bytes]).toEqual([...high]);
  });
});

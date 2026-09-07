/**
 * Code page 858 - what the TM-T88V needs for French text plus the euro sign.
 *
 * The printer's default code page has no euro glyph, so AC "caractères français
 * et symbole euro" cannot be met without selecting one explicitly. CP858 is
 * CP850 with the euro at 0xD5, which covers every accented letter French uses.
 *
 * Encoding never fails silently: a character with no byte in the page is
 * transliterated (or replaced) AND reported in `unmapped`, so a caller can log
 * that a glyph was substituted instead of discovering it on paper.
 */

/** Unicode code points for bytes 0x80..0xFF, 16 per row for easy auditing. */
const HIGH_RANGE = [
  // 0x80
  'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç', 'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å',
  // 0x90
  'É', 'æ', 'Æ', 'ô', 'ö', 'ò', 'û', 'ù', 'ÿ', 'Ö', 'Ü', 'ø', '£', 'Ø', '×', 'ƒ',
  // 0xA0
  'á', 'í', 'ó', 'ú', 'ñ', 'Ñ', 'ª', 'º', '¿', '®', '¬', '½', '¼', '¡', '«', '»',
  // 0xB0
  '░', '▒', '▓', '│', '┤', 'Á', 'Â', 'À', '©', '╣', '║', '╗', '╝', '¢', '¥', '┐',
  // 0xC0
  '└', '┴', '┬', '├', '─', '┼', 'ã', 'Ã', '╚', '╔', '╩', '╦', '╠', '═', '╬', '¤',
  // 0xD0 - 0xD5 is the euro, and the only difference from CP850
  'ð', 'Ð', 'Ê', 'Ë', 'È', '€', 'Í', 'Î', 'Ï', '┘', '┌', '█', '▄', '¦', 'Ì', '▀',
  // 0xE0
  'Ó', 'ß', 'Ô', 'Ò', 'õ', 'Õ', 'µ', 'þ', 'Þ', 'Ú', 'Û', 'Ù', 'ý', 'Ý', '¯', '´',
  // 0xF0
  '­', '±', '‗', '¾', '¶', '§', '÷', '¸', '°', '¨', '·', '¹', '³', '²', '■', ' ',
] as const;

/** ESC t argument that selects CP858 on an Epson printer. */
export const CP858_SELECTOR = 19;

if (HIGH_RANGE.length !== 128) {
  throw new Error(`CP858 table must hold 128 entries, got ${HIGH_RANGE.length}`);
}

const CHAR_TO_BYTE = new Map<string, number>();
const BYTE_TO_CHAR = new Map<number, string>();
for (let index = 0; index < HIGH_RANGE.length; index++) {
  const char = HIGH_RANGE[index];
  if (char === undefined) continue;
  const byte = 0x80 + index;
  BYTE_TO_CHAR.set(byte, char);
  // First definition wins, so a duplicate glyph keeps its canonical byte.
  if (!CHAR_TO_BYTE.has(char)) CHAR_TO_BYTE.set(char, byte);
}

/**
 * Typographic characters that have no CP858 byte but a well-understood ASCII
 * equivalent. Booksy output contains curly quotes and non-breaking spaces.
 */
const ASCII_FALLBACKS = new Map<string, string>([
  ['’', "'"],
  ['‘', "'"],
  ['“', '"'],
  ['”', '"'],
  ['–', '-'],
  ['—', '-'],
  ['…', '...'],
  // Booksy separates payment method from timestamp with a bullet. CP858 has no
  // bullet but does have a middle dot (0xFA), which reads correctly on paper -
  // falling through to '?' would look like a defect.
  ['\u2022', '\u00b7'],
  ['œ', 'oe'],
  ['Œ', 'OE'],
  ['Ÿ', 'Y'],
]);

/**
 * Space variants that become a plain 0x20.
 *
 * CP858 does map NBSP, to 0xFF - but a plain space is guaranteed to come out
 * blank on any firmware, whereas 0xFF depends on the printer honouring the page.
 * French text puts a NBSP before the euro sign and the percent sign, so this
 * path is taken on nearly every ticket. It is a normalisation, not a loss, and
 * so is deliberately NOT reported as unmapped.
 */
const SPACE_VARIANTS = new Set([
  '\u00a0',
  '\u202f',
  '\u2007',
  '\u2008',
  '\u2009',
  '\u200a',
]);

export interface EncodeResult {
  bytes: Uint8Array;
  /** Distinct characters that had to be substituted, in first-seen order. */
  unmapped: string[];
}

/** Strip combining marks, e.g. "ẽ" -> "e", so a rare accent still prints. */
function deaccent(char: string): string {
  return char.normalize('NFD').replace(/\p{Mn}/gu, '');
}

export function encodeCp858(text: string): EncodeResult {
  const bytes: number[] = [];
  const unmapped: string[] = [];

  const note = (char: string): void => {
    if (!unmapped.includes(char)) unmapped.push(char);
  };

  // Iterate by code point so astral characters are handled as single units.
  for (const rawChar of text) {
    const char = SPACE_VARIANTS.has(rawChar) ? ' ' : rawChar;
    const code = char.codePointAt(0) ?? 0;

    if (code === 0x0a || code === 0x0d) {
      bytes.push(code);
      continue;
    }
    if (code >= 0x20 && code <= 0x7e) {
      bytes.push(code);
      continue;
    }

    const direct = CHAR_TO_BYTE.get(char);
    if (direct !== undefined) {
      bytes.push(direct);
      continue;
    }

    const fallback = ASCII_FALLBACKS.get(char) ?? deaccent(char);
    if (fallback !== '' && fallback !== char) {
      note(char);
      for (const replacement of fallback) {
        const byte = CHAR_TO_BYTE.get(replacement);
        const replacementCode = replacement.codePointAt(0) ?? 0x3f;
        bytes.push(
          byte ?? (replacementCode >= 0x20 && replacementCode <= 0x7e ? replacementCode : 0x3f),
        );
      }
      continue;
    }

    note(char);
    bytes.push(0x3f); // '?'
  }

  return { bytes: new Uint8Array(bytes), unmapped };
}

/** Inverse of encodeCp858, for the offline decoder. */
export function decodeCp858(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    if (byte < 0x80) out += String.fromCharCode(byte);
    else out += BYTE_TO_CHAR.get(byte) ?? '�';
  }
  return out;
}

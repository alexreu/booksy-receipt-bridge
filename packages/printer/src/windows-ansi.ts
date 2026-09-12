/**
 * Encode a ticket for a print job sent as TEXT.
 *
 * The Windows print processor reads a TEXT job in the machine's ANSI code
 * page, which on a French till is Windows-1252. Handing it UTF-8 turns every
 * accent into two wrong characters, and a receipt is mostly names and amounts.
 *
 * Not the same thing as the ESC/POS code page (PC858): that one is the
 * printer's own table, used when the bytes go straight to the head. This one
 * is Windows'. Two encodings, because there are two routes to the paper.
 */

/** The Windows-1252 positions that differ from Latin-1. */
const WINDOWS_1252: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  ƒ: 0x83,
  '„': 0x84,
  '…': 0x85,
  '†': 0x86,
  '‡': 0x87,
  ˆ: 0x88,
  '‰': 0x89,
  Š: 0x8a,
  '‹': 0x8b,
  Œ: 0x8c,
  Ž: 0x8e,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '˜': 0x98,
  '™': 0x99,
  š: 0x9a,
  '›': 0x9b,
  œ: 0x9c,
  ž: 0x9e,
  Ÿ: 0x9f,
};

/**
 * CRLF line endings: a print processor reading a bare LF can run the whole
 * ticket into a single line.
 */
export function toWindowsAnsi(text: string): Uint8Array {
  const normalised = text.replace(/\r?\n/g, '\r\n');
  const bytes: number[] = [];

  for (const character of normalised) {
    const mapped = WINDOWS_1252[character] ?? character.codePointAt(0) ?? 0x3f;
    // '?' rather than a broken byte for anything the code page cannot hold -
    // the same substitution the ESC/POS emitter makes, and reports.
    bytes.push(mapped > 0xff ? 0x3f : mapped);
  }
  return Uint8Array.from(bytes);
}

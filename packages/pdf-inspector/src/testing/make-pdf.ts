/**
 * Minimal PDF writer used only by tests.
 *
 * Exists so the inspector has a deterministic fixture that carries no customer
 * data: real Booksy receipts contain client names and cannot be committed.
 * It writes uncompressed content streams and a correct xref table - just enough
 * for pdf.js to parse it as a normal document.
 */

export interface SyntheticTextLine {
  text: string;
  /** PDF units from the left edge. */
  x: number;
  /** PDF units from the BOTTOM edge (native PDF space). */
  y: number;
  size?: number;
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;

/** Escape the three characters that are special inside a PDF literal string. */
function escapeString(text: string): string {
  return text.replace(/[\\()]/g, (char) => `\\${char}`);
}

/**
 * Encode to WinAnsi bytes. Code points below 0x100 map one-to-one (Latin-1 is a
 * subset of WinAnsiEncoding for the accented letters we care about); anything
 * above is out of scope for a test fixture and becomes '?'.
 */
function winAnsiBytes(text: string): Buffer {
  const out = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i] = code < 0x100 ? code : 0x3f;
  }
  return out;
}

export function makeSyntheticPdf(pages: readonly SyntheticTextLine[][]): Uint8Array {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;

  const push = (value: string | Buffer): void => {
    const buffer = typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
    chunks.push(buffer);
    length += buffer.length;
  };

  // Object ids: 1 catalog, 2 pages, 3 font, then (page, content) pairs from 4.
  const pageObjectId = (index: number): number => 4 + index * 2;
  const contentObjectId = (index: number): number => 5 + index * 2;
  const totalObjects = 3 + pages.length * 2;

  const beginObject = (id: number): void => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
  };

  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');

  beginObject(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObject(2);
  const kids = pages.map((_, index) => `${pageObjectId(index)} 0 R`).join(' ');
  push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  beginObject(3);
  push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ' +
      '/Encoding /WinAnsiEncoding >>\nendobj\n',
  );

  pages.forEach((lines, index) => {
    beginObject(pageObjectId(index));
    push(
      `<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> ` +
        `/Contents ${contentObjectId(index)} 0 R >>\nendobj\n`,
    );

    const body: Buffer[] = [Buffer.from('BT\n', 'latin1')];
    for (const line of lines) {
      body.push(Buffer.from(`/F1 ${line.size ?? 10} Tf\n`, 'latin1'));
      body.push(Buffer.from(`1 0 0 1 ${line.x} ${line.y} Tm\n`, 'latin1'));
      body.push(Buffer.from('(', 'latin1'));
      body.push(winAnsiBytes(escapeString(line.text)));
      body.push(Buffer.from(') Tj\n', 'latin1'));
    }
    body.push(Buffer.from('ET\n', 'latin1'));
    const stream = Buffer.concat(body);

    beginObject(contentObjectId(index));
    push(`<< /Length ${stream.length} >>\nstream\n`);
    push(stream);
    push('endstream\nendobj\n');
  });

  const xrefOffset = length;
  push(`xref\n0 ${totalObjects + 1}\n`);
  push('0000000000 65535 f \n');
  for (let id = 1; id <= totalObjects; id++) {
    push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\n`);
  push(`startxref\n${xrefOffset}\n%%EOF\n`);

  return new Uint8Array(Buffer.concat(chunks));
}

/** A two-page fixture shaped loosely like a receipt, with no real data in it. */
export function syntheticReceiptPdf(): Uint8Array {
  return makeSyntheticPdf([
    [
      { text: 'SALON DEMO', x: 60, y: 780, size: 14 },
      { text: '12 rue de Nulle Part', x: 60, y: 760 },
      { text: 'SIRET 000 000 000 00000', x: 60, y: 745 },
      { text: 'Ticket n 996', x: 60, y: 710 },
      { text: 'Coupe', x: 60, y: 680 },
      { text: '25,00', x: 480, y: 680 },
      { text: 'Couleur avec un libelle tres long', x: 60, y: 665 },
      { text: '48,50', x: 480, y: 665 },
      { text: 'TOTAL TTC', x: 60, y: 620 },
      { text: '73,50', x: 480, y: 620 },
      { text: 'TVA 20%', x: 60, y: 600 },
      { text: '12,25', x: 480, y: 600 },
      { text: 'Accents : ecole, cafe, ou, ca', x: 60, y: 560 },
    ],
    [{ text: 'NF525 signature ABCDEF0123456789', x: 60, y: 780 }],
  ]);
}

/**
 * Turn an inspector dump of a real receipt into a committable fixture.
 *
 * Real Booksy receipts carry a merchant's SIRET, a customer id and an employee
 * name, so `fixtures/booksy/*.pdf` is gitignored. The parser still needs a
 * fixture with REAL GEOMETRY, because that geometry is exactly what it reasons
 * about. This replaces the identifying strings with same-shape placeholders and
 * keeps every coordinate, then regenerates a matching PDF so the buffer entry
 * point can be tested too.
 *
 *   pnpm tsx scripts/anonymize-inspection.ts debug/recu-1167.json recu-1167
 *
 * Writes fixtures/booksy/<name>.anon.json and <name>.anon.pdf.
 *
 * Amounts, dates, VAT codes, labels and the software version are kept: they are
 * what the parser reads and none of them identify a person.
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  groupIntoLines,
  linesToText,
} from '../packages/pdf-inspector/src/extract.ts';
import type { PdfInspection, PdfTextItem } from '../packages/pdf-inspector/src/types.ts';
import {
  makeSyntheticPdf,
  type SyntheticTextLine,
} from '../packages/pdf-inspector/src/testing/make-pdf.ts';

/**
 * Replacements by SHAPE, never by literal value.
 *
 * Naming the real strings would defeat the point: this script would then be the
 * place the identifying data lives, committed alongside the fixture it was
 * supposed to scrub. Every rule below matches a pattern, so the script works on
 * any receipt and contains nothing about a particular business.
 *
 * The merchant name is the one field with no pattern of its own, so it is found
 * by POSITION instead - see `merchantNameIndex`.
 */
const REPLACEMENTS: Array<[RegExp, string]> = [
  [/^SIRET: \d+$/, 'SIRET: 00000000000000'],
  [/^N° TVA: [A-Z]{2}\d+$/, 'N° TVA: FR00000000000'],
  [
    /^\d+ .*, \d{5}, .*, France$/,
    '1 Rue Exemple Quartier Témoin, 00000, VILLE EXEMPLE, France',
  ],
  [/^Identifiant client: \d+$/, 'Identifiant client: 00000000'],
  [/^Créé par: .* • ID: \d+$/, 'Créé par: Prénom Nom • ID: 0000000'],
  [/^\(NF525\)_.*$/, '(NF525)_B_0000-0_XxxX'],
];

function anonymise(text: string): string {
  for (const [pattern, replacement] of REPLACEMENTS) {
    if (pattern.test(text)) return replacement;
  }
  return text;
}

/**
 * Which run holds the merchant name.
 *
 * The name is whatever sits directly above the SIRET line - the same relative
 * rule the parser uses. Derived rather than declared, so this file never has to
 * contain a real business name.
 */
function merchantNameIndex(items: readonly PdfTextItem[]): number {
  const siret = items.findIndex((item) => /^SIRET\s*:/.test(item.text));
  if (siret === -1) return -1;

  const above = items
    .map((item, index) => ({ item, index }))
    .filter((entry) => entry.item.isWhitespace !== true && entry.item.text.trim() !== '')
    .filter((entry) => entry.item.yTop < (items[siret]?.yTop ?? 0))
    .sort((a, b) => b.item.yTop - a.item.yTop);

  return above[0]?.index ?? -1;
}

const [inputPath, name] = process.argv.slice(2);
if (inputPath === undefined || name === undefined) {
  process.stderr.write(
    'Usage: pnpm tsx scripts/anonymize-inspection.ts <debug/x.json> <fixture-name>\n',
  );
  process.exit(2);
}

const inspection = JSON.parse(await readFile(inputPath, 'utf8')) as PdfInspection;

const nameIndex = merchantNameIndex(inspection.items);

let replaced = 0;
const items: PdfTextItem[] = inspection.items.map((item, index) => {
  const text = index === nameIndex ? 'SALON EXEMPLE COIFFURE' : anonymise(item.text);
  if (text === item.text) return item;
  replaced++;
  // Keep x and the vertical position; scale the advance to the new length so the
  // geometry stays self-consistent.
  const perChar = item.text.length === 0 ? 0 : item.width / item.text.length;
  return { ...item, text, width: Math.round(perChar * text.length * 100) / 100 };
});

// Rebuild every derived field from the anonymised runs. The inspector CLI also
// writes a `lines` array; carrying it over verbatim would republish the original
// text next to the scrubbed runs, which is how a fixture leaks.
const { items: _originalItems, ...rest } = inspection as PdfInspection &
  Record<string, unknown>;
const anonymised = {
  ...rest,
  items,
  lines: linesToText(groupIntoLines(items)),
};
const jsonPath = `fixtures/booksy/${name}.anon.json`;
const serialised = `${JSON.stringify(anonymised, null, 2)}\n`;

// Refuse to write a fixture that still contains anything the replacements were
// meant to remove.
const scrubbed = [
  ...REPLACEMENTS.flatMap(([pattern]) =>
    inspection.items.filter((item) => pattern.test(item.text)).map((item) => item.text),
  ),
  ...(nameIndex === -1 ? [] : [inspection.items[nameIndex]?.text ?? '']),
].filter((text) => text !== '');

const leaks = scrubbed.filter((text) => serialised.includes(text));
if (leaks.length > 0) {
  process.stderr.write(`refusing to write: original text survives\n`);
  for (const leak of leaks) process.stderr.write(`  ${leak}\n`);
  process.exit(1);
}

await writeFile(jsonPath, serialised, 'utf8');

// Regenerate a PDF from the anonymised runs, one page per source page.
const pages: SyntheticTextLine[][] = [];
for (let page = 1; page <= inspection.pageCount; page++) {
  pages.push(
    items
      .filter((item) => item.page === page && item.isWhitespace !== true)
      .map((item) => ({
        text: item.text,
        x: item.x,
        y: item.y,
        size: Math.max(4, Math.round(item.height)),
      })),
  );
}
const pdfPath = `fixtures/booksy/${name}.anon.pdf`;
await writeFile(pdfPath, makeSyntheticPdf(pages));

process.stderr.write(`replaced ${replaced} run(s)\n-> ${jsonPath}\n-> ${pdfPath}\n`);

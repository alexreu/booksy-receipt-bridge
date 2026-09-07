/**
 * PDF Inspector CLI (plan section 32).
 *
 *   pnpm inspect ./fixtures/booksy/ticket-996.pdf   ->  ./debug/ticket-996.json
 *
 * Deliberately dumb: it dumps coordinates and does no Booksy-specific reasoning.
 * Reading its output is what phase 2 is designed around.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { groupIntoLines, inspectPdf, linesToText } from './extract.ts';

const DEBUG_DIR = 'debug';

async function main(argv: readonly string[]): Promise<number> {
  const input = argv[0];
  if (input === undefined || input === '--help' || input === '-h') {
    process.stderr.write(
      'Usage: pnpm inspect <path-to-pdf> [--out <dir>]\n' +
        '  Writes <dir>/<name>.json (default dir: debug/)\n',
    );
    return input === undefined ? 2 : 0;
  }

  const outFlag = argv.indexOf('--out');
  const outDir = outFlag === -1 ? DEBUG_DIR : (argv[outFlag + 1] ?? DEBUG_DIR);

  const pdfPath = resolve(input);
  let data: Buffer;
  try {
    data = await readFile(pdfPath);
  } catch {
    process.stderr.write(`Cannot read ${pdfPath}\n`);
    return 1;
  }

  const inspection = await inspectPdf(new Uint8Array(data));
  const lines = linesToText(groupIntoLines(inspection.items));

  const name = basename(input, extname(input));
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, `${name}.json`);
  await writeFile(
    outPath,
    `${JSON.stringify({ file: basename(input), ...inspection, lines }, null, 2)}\n`,
    'utf8',
  );

  process.stderr.write(
    `${inspection.pageCount} page(s), ${inspection.items.length} text run(s), ` +
      `${lines.length} line(s)\n`,
  );
  if (inspection.looksLikeScan) {
    process.stderr.write(
      'WARNING: no text layer found. This PDF is probably a scan, and no ' +
        'coordinate-based parser can read it.\n',
    );
  }
  process.stderr.write(`-> ${outPath}\n`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });

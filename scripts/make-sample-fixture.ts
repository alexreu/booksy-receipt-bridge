/**
 * Writes a committable, PII-free PDF so `pnpm inspect` is demonstrable before a
 * real Booksy receipt exists. The `.anon.pdf` suffix is what .gitignore allows.
 */
import { writeFile } from 'node:fs/promises';
import { syntheticReceiptPdf } from '../packages/pdf-inspector/src/testing/make-pdf.ts';

const target = 'fixtures/booksy/sample-synthetic.anon.pdf';
await writeFile(target, syntheticReceiptPdf());
process.stderr.write(`-> ${target}\n`);

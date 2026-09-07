/**
 * Produces the byte files the phase 1.5b spike sends to a real printer, plus the
 * text and SVG replays used to check the paper against expectations.
 *
 *   pnpm spike:sample
 */
import { buildTicketLayout, nominalReceipt, stressReceipt } from '@brb/ticket-layout';
import { emitEscPos } from '@brb/receipt-renderer';
import {
  DEFAULT_PRINTER_CONFIG,
  FilePrinterAdapter,
  type PrinterConfig,
} from '@brb/printer';

const OUT_DIR = 'debug';

const config: PrinterConfig = {
  // A placeholder: the file sink ignores it, and the spike script takes the real
  // queue name on the command line. Nothing in the codebase targets one model.
  name: 'spike-file-sink',
  ...DEFAULT_PRINTER_CONFIG,
};

const testTicket = new FilePrinterAdapter({ outDir: OUT_DIR, name: 'spike-test-ticket' });
const testResult = await testTicket.printTest(config);

const written: string[] = [...testTicket.written];
const substituted = new Set(testResult.unmapped ?? []);

for (const [name, make] of [
  ['spike-nominal-ticket', nominalReceipt],
  ['spike-stress-ticket', stressReceipt],
] as const) {
  const { bytes, unmapped } = emitEscPos(buildTicketLayout(make(), { columns: config.columns }));
  const sink = new FilePrinterAdapter({ outDir: OUT_DIR, name });
  await sink.printRaw(bytes, config);
  written.push(...sink.written);
  for (const char of unmapped) substituted.add(char);
}

for (const path of written) process.stderr.write(`-> ${path}\n`);
if (substituted.size > 0) {
  process.stderr.write(
    `\nCharacters with no CP858 byte, substituted: ${[...substituted].join(' ')}\n` +
      'Check these against the paper when the spike runs.\n',
  );
}
process.stderr.write(`\nNext: see spikes/escpos-raw/README.md\n`);

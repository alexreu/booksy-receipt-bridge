/**
 * Standalone CLI (plan section 58).
 *
 * The host has to be usable without the extension: a Booksy PDF in, a ticket
 * out. That keeps the parser, the layout and the printer honest, because none of
 * them may depend on a browser being present, and it is how the pipeline gets
 * exercised on a machine with no printer at all.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { BooksyParseError, parseBooksyReceipt } from '@brb/booksy-parser';
import type { ConfigPatch } from '@brb/shared';
import { decodeToText, emitEscPos, emitHtml, emitText } from '@brb/receipt-renderer';
import { buildTicketLayout } from '@brb/ticket-layout';
import { createHost } from './host.ts';
import { silentLogger } from './logging/logger.ts';
import { loadConfig, saveConfig } from './config/config.ts';
import { configPath, dataDir, logDir } from './paths.ts';
import { HOST_VERSION } from './version.ts';

const USAGE = `booksy-receipt-bridge ${HOST_VERSION}

Sans argument, le host parle le protocole Native Messaging sur stdin/stdout.

  ping                     Répond comme au message PING
  status                   Répond comme au message GET_STATUS
  config                   Affiche la configuration et son emplacement
  config set <clé> <val>   printer.name, printer.columns, printing.autoPrint, ...
  paths                    Affiche les dossiers de données et de logs
  parse <pdf>              Lit un reçu Booksy et affiche le Receipt en JSON
  ticket <pdf>             Affiche le ticket 80 mm en texte
  html <pdf> [--out f]     Écrit l'aperçu HTML
  escpos <pdf> --out f     Écrit les octets ESC/POS
`;

export async function runCli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case '-h':
    case '--help':
      out(USAGE);
      return 0;

    case '--version':
      out(`${HOST_VERSION}\n`);
      return 0;

    case 'ping':
    case 'status': {
      const host = createHost({ log: silentLogger() });
      const response = await host.handle({
        id: 'cli',
        type: command === 'ping' ? 'PING' : 'GET_STATUS',
      });
      out(`${JSON.stringify(response, null, 2)}\n`);
      return response.success ? 0 : 1;
    }

    case 'paths':
      out(`data:   ${dataDir()}\nconfig: ${configPath()}\nlogs:   ${logDir()}\n`);
      return 0;

    case 'config':
      return configCommand(rest);

    case 'parse':
    case 'ticket':
    case 'html':
    case 'escpos':
      return receiptCommand(command, rest);

    default:
      err(`Commande inconnue : ${command}\n\n${USAGE}`);
      return 2;
  }
}

function configCommand(argv: readonly string[]): number {
  const path = configPath();

  if (argv[0] === 'set') {
    const [, key, value] = argv;
    if (key === undefined || value === undefined) {
      err('Usage : config set <clé> <valeur>\n');
      return 2;
    }
    const patch = buildPatch(key, value);
    if (patch === undefined) {
      err(`Clé inconnue : ${key}\n`);
      return 2;
    }
    const saved = saveConfig(path, patch);
    out(`${JSON.stringify(saved, null, 2)}\n`);
    return 0;
  }

  const state = loadConfig(path);
  out(`# ${path}${state.present ? '' : ' (absent, valeurs par défaut)'}\n`);
  if (state.error !== undefined) err(`${state.error}\n`);
  out(`${JSON.stringify(state.config, null, 2)}\n`);
  return 0;
}

function buildPatch(key: string, value: string): ConfigPatch | undefined {
  switch (key) {
    case 'printer.name':
      return { printer: { name: value } };
    case 'printer.paperWidth':
      return { printer: { paperWidth: Number(value) } };
    case 'printer.printableWidth':
      return { printer: { printableWidth: Number(value) } };
    case 'printer.columns':
      return { printer: { columns: Number(value) } };
    case 'printing.autoPrint':
      return { printing: { autoPrint: value === 'true' } };
    case 'printing.showPreview':
      return { printing: { showPreview: value === 'true' } };
    case 'printing.confidenceThreshold':
      return { printing: { confidenceThreshold: Number(value) } };
    default:
      return undefined;
  }
}

async function receiptCommand(command: string, argv: readonly string[]): Promise<number> {
  const path = argv[0];
  if (path === undefined) {
    err(`Usage : ${command} <pdf>\n`);
    return 2;
  }
  const outFlag = argv.indexOf('--out');
  const outPath = outFlag === -1 ? undefined : argv[outFlag + 1];

  const { config } = loadConfig(configPath());

  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch {
    err(`Fichier illisible : ${path}\n`);
    return 1;
  }

  let parsed;
  try {
    parsed = await parseBooksyReceipt(new Uint8Array(buffer));
  } catch (error) {
    if (error instanceof BooksyParseError) {
      err(`${error.code} : ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const { receipt, confidence, warnings } = parsed;
  for (const warning of warnings) err(`WARN ${warning.code} ${warning.message}\n`);
  err(`confidence ${confidence}\n`);

  if (command === 'parse') {
    out(`${JSON.stringify(receipt, null, 2)}\n`);
    return 0;
  }

  const layout = buildTicketLayout(receipt, { columns: config.printer.columns });

  if (command === 'ticket') {
    out(`${emitText(layout)}\n`);
    return 0;
  }

  if (command === 'html') {
    const html = emitHtml(layout, {
      paperWidth: config.printer.paperWidth,
      printableWidth: config.printer.printableWidth,
      title: `Reçu ${receipt.ticket.number}`,
    });
    if (outPath === undefined) out(html);
    else {
      await writeFile(outPath, html, 'utf8');
      err(`-> ${outPath}\n`);
    }
    return 0;
  }

  // escpos
  if (outPath === undefined) {
    err('escpos exige --out : les octets ne doivent pas atterrir dans un terminal.\n');
    return 2;
  }
  const { bytes, unmapped } = emitEscPos(layout);
  await writeFile(outPath, bytes);
  if (unmapped.length > 0) err(`caractères substitués : ${unmapped.join(' ')}\n`);
  err(`${bytes.length} octets -> ${outPath}\n`);
  out(`${decodeToText(bytes)}\n`);
  return 0;
}

function out(text: string): void {
  process.stdout.write(text);
}

function err(text: string): void {
  process.stderr.write(text);
}

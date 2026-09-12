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
import { install, uninstall } from './install/install.ts';
import { parseExtensionIds } from './install/targets.ts';
import { HOST_VERSION } from './version.ts';

const USAGE = `booksy-receipt-bridge ${HOST_VERSION}

Sans argument, le host parle le protocole Native Messaging sur stdin/stdout.

  ping                     Répond comme au message PING
  status                   Répond comme au message GET_STATUS
  config                   Affiche la configuration et son emplacement
  config set <clé> <val>   printer.name, printer.columns, printing.autoPrint, ...
  paths                    Affiche les dossiers de données et de logs
  update [--download]      Cherche une version plus récente sur GitHub
  install [--id a,b]       Installe le service et l'enregistre auprès des
                           navigateurs, sans PowerShell ni élévation
  uninstall                Retire le service et ses enregistrements
  parse <pdf>              Lit un reçu Booksy et affiche le Receipt en JSON
  ticket <pdf>             Affiche le ticket 80 mm en texte
  html <pdf> [--out f]     Écrit l'aperçu HTML
  escpos <pdf> --out f     Écrit les octets ESC/POS
  print <pdf> [--printer n]
                           Imprime pour de vrai et affiche l'erreur exacte
                           si ça échoue, sans passer par le navigateur
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

    case 'update': {
      const host = createHost({ log: silentLogger() });
      const response = await host.handle({
        id: 'cli',
        type: rest.includes('--download') ? 'DOWNLOAD_UPDATE' : 'CHECK_UPDATE',
      });
      out(`${JSON.stringify(response.data ?? response, null, 2)}\n`);
      return response.success ? 0 : 1;
    }

    case 'paths':
      out(`data:   ${dataDir()}\nconfig: ${configPath()}\nlogs:   ${logDir()}\n`);
      return 0;

    case 'config':
      return configCommand(rest);

    case 'print':
      return runPrint(rest);

    case 'install':
      return runInstall(rest);

    case 'uninstall':
      return runUninstall();

    case 'parse':
    case 'ticket':
    case 'html':
    case 'escpos':
      return receiptCommand(command, rest);

    case '--unknown': {
      // main.ts routes here when argv looks like a mistyped command rather
      // than a browser launch argument.
      err(`Commande inconnue : ${rest[0] ?? ''}\n\n${USAGE}`);
      return 2;
    }

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

/** The extension this build is meant to talk to. */
const DEFAULT_EXTENSION_ID = 'ndfcmfgnelpdjgpmaelpdgoccmjcpdjm';

async function runInstall(argv: readonly string[]): Promise<number> {
  const flag = argv.indexOf('--id');
  const ids =
    flag === -1 ? [DEFAULT_EXTENSION_ID] : parseExtensionIds(argv[flag + 1] ?? '');

  out('\nBooksy Receipt Bridge — installation\n\n');
  const result = await install({ extensionIds: ids, log: (message) => out(`${message}\n`) });

  if (!result.ok) {
    err(`\n${result.error ?? 'Installation impossible.'}\n`);
    return 1;
  }

  const load = result.extensionPath ?? '<dossier extension de la livraison>';
  out(
    `\nInstallation terminée.\n\n` +
      `  1. Ouvrez chrome://extensions (Edge : edge://extensions), activez le\n` +
      `     mode développeur, puis « Charger l'extension non empaquetée » et\n` +
      `     choisissez EXACTEMENT ce dossier :\n\n` +
      `       ${load}\n\n` +
      `  2. Ouvrez le popup de l'extension : « Service connecté ».\n` +
      `  3. Choisissez l'imprimante dans Paramètres.\n\n` +
      `Désinstallation : "${result.executable}" uninstall\n`,
  );
  return 0;
}

async function runUninstall(): Promise<number> {
  out('\nBooksy Receipt Bridge — désinstallation\n\n');
  const result = await uninstall({ log: (message) => out(`${message}\n`) });
  out(
    `\nTerminé. La configuration et les journaux sont conservés.\n` +
      `Retirez aussi l'extension du navigateur, sur chrome://extensions.\n`,
  );
  void result;
  return 0;
}

/**
 * Print, and say plainly what happened.
 *
 * The popup shows a failure in one line and the rest goes to a log file, which
 * on a till means asking someone to open a folder they have never opened. Here
 * the reason is on screen, and the exit code says whether paper came out.
 */
async function runPrint(argv: readonly string[]): Promise<number> {
  const file = argv.find((argument) => !argument.startsWith('--'));
  if (file === undefined) {
    err('Usage : print <pdf> [--printer "Nom de l\'imprimante"]\n');
    return 2;
  }
  const flag = argv.indexOf('--printer');
  const printerName = flag === -1 ? undefined : argv[flag + 1];

  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    err(`Fichier illisible : ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const host = createHost({ log: silentLogger() });
  const response = await host.handle({
    id: 'cli',
    type: 'PRINT_RECEIPT',
    payload: {
      source: { kind: 'bytes', base64: bytes.toString('base64') },
      trigger: 'user',
      ...(printerName === undefined ? {} : { printerName }),
    },
  });

  if (!response.success) {
    // The detail is the part that says WHAT failed: the spooler's own words,
    // the queue that does not exist. The message alone is a category.
    const { code, message, detail } = response.error ?? {};
    err(`ÉCHEC ${code ?? 'INCONNU'} : ${message ?? 'raison inconnue'}\n`);
    if (detail !== undefined && detail !== '') err(`${detail}\n`);
    return 1;
  }

  const data = response.data as { ticketNumber?: string; duplicate?: boolean } | undefined;
  if (data?.duplicate === true) {
    out(
      `Ticket ${data.ticketNumber ?? '?'} considéré comme déjà imprimé : rien envoyé.\n` +
        `Attendez deux minutes, ou videz l'historique pour forcer.\n`,
    );
    return 0;
  }
  out(`Ticket ${data?.ticketNumber ?? '?'} envoyé à l'imprimante.\n`);
  return 0;
}

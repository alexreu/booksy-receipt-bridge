import { BooksyParseError, parseBooksyReceipt } from '@brb/booksy-parser';
import { emitEscPos } from '@brb/receipt-renderer';
import { buildTicketLayout } from '@brb/ticket-layout';
import type { PrintReceiptData, PrintTestData, ReceiptSource } from '@brb/shared';
import type { BridgeErrorCode, Clock } from '@brb/shared';
import type { PrinterAdapter, PrinterConfig } from '@brb/printer';
import type { BridgeConfig } from '../config/config.ts';
import type { Logger } from '../logging/logger.ts';
import { checkAndRecord, dedupeKey, windowFor } from './dedupe.ts';
import { resolveSource } from './source.ts';

export type PrintOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; code: BridgeErrorCode; message: string };

export interface PrintDeps {
  printer: PrinterAdapter;
  config: BridgeConfig;
  log: Logger;
  /** Where the print history lives; see dedupe.ts. */
  historyPath: string;
  now: Clock;
}

export function printerConfigOf(config: BridgeConfig): PrinterConfig {
  return {
    name: config.printer.name,
    paperWidth: config.printer.paperWidth,
    printableWidth: config.printer.printableWidth,
    columns: config.printer.columns,
  };
}

export async function printTest(deps: PrintDeps): Promise<PrintOutcome<PrintTestData>> {
  if (deps.config.printer.name === '') {
    return { ok: false, code: 'PRINTER_NOT_FOUND', message: 'Aucune imprimante configurée.' };
  }
  const result = await deps.printer.printTest(printerConfigOf(deps.config));
  if (!result.ok) {
    deps.log.error(`Test d'impression échoué : ${result.error ?? 'raison inconnue'}`);
    return { ok: false, code: 'PRINT_FAILED', message: result.error ?? 'Impression échouée.' };
  }
  deps.log.info(`Test d'impression envoyé (${result.bytesSent ?? 0} octets)`);
  return { ok: true, data: pick(result) };
}

/**
 * Read a receipt and print it.
 *
 * The order matters: resolve the source, parse it, gate on confidence, dedupe,
 * then print. Every check that can refuse happens before a single byte reaches
 * the spooler, because paper cannot be un-printed.
 *
 * Nothing here recomputes a fiscal value; the parser's warnings are passed
 * straight back so the caller can show them (plan section 31).
 */
export async function printReceipt(
  payload: {
    source: ReceiptSource;
    dedupeKey?: string;
    printerName?: string;
    trigger?: 'user' | 'auto';
  },
  deps: PrintDeps,
): Promise<PrintOutcome<PrintReceiptData>> {
  const trigger = payload.trigger ?? 'user';

  // A printer chosen in the preview applies to this job only: it must not
  // silently become the stored default. The column count is a property of the
  // paper, so it stays in the configuration.
  const printerName = payload.printerName ?? deps.config.printer.name;
  const { columns } = deps.config.printer;

  if (printerName === '') {
    return { ok: false, code: 'PRINTER_NOT_FOUND', message: 'Aucune imprimante configurée.' };
  }

  const source = await resolveSource(payload.source, {
    allowedDirs: deps.config.printing.allowedDirs,
  });
  if (!source.ok) {
    deps.log.warn(`Source refusée : ${source.message}`);
    return { ok: false, code: source.code, message: source.message };
  }

  let parsed;
  try {
    parsed = await parseBooksyReceipt(source.bytes);
  } catch (error) {
    if (error instanceof BooksyParseError) {
      deps.log.warn(`${error.code} : ${error.message}`);
      return { ok: false, code: error.code, message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    deps.log.error(`Lecture échouée : ${message}`);
    return { ok: false, code: 'PARSING_FAILED', message };
  }

  const { receipt, confidence, warnings } = parsed;
  // Ticket number and confidence only. A log is not the place for a customer
  // name or an address (plan section 39).
  deps.log.info(`Reçu Booksy reconnu, ticket ${receipt.ticket.number}, confiance ${confidence}`);
  for (const warning of warnings) deps.log.warn(`${warning.code} ${warning.message}`);

  const threshold = deps.config.printing.confidenceThreshold;
  if (trigger === 'auto' && confidence < threshold) {
    deps.log.info(`Impression automatique refusée : ${confidence} < ${threshold}`);
    return {
      ok: false,
      code: 'INVALID_RECEIPT',
      message:
        `Lecture trop incertaine pour une impression automatique ` +
        `(${Math.round(confidence * 100)} %, seuil ${Math.round(threshold * 100)} %).`,
    };
  }

  const key =
    payload.dedupeKey ??
    dedupeKey(
      trigger,
      {
        ticketNumber: receipt.ticket.number,
        ...(receipt.ticket.issuedAt === undefined ? {} : { issuedAt: receipt.ticket.issuedAt }),
        totalTTC: receipt.totals.totalTTC,
      },
      source.sha256,
    );

  const { duplicate } = checkAndRecord(key, {
    path: deps.historyPath,
    windowMs: windowFor(trigger),
    now: deps.now,
  });

  const base: PrintReceiptData = {
    ticketNumber: receipt.ticket.number,
    confidence,
    warnings,
  };

  if (duplicate) {
    deps.log.info(`Ticket ${receipt.ticket.number} déjà imprimé récemment, job ignoré`);
    return { ok: true, data: { ...base, duplicate: true } };
  }

  const { bytes, unmapped } = emitEscPos(buildTicketLayout(receipt, { columns }));
  const result = await deps.printer.printRaw(bytes, {
    ...printerConfigOf(deps.config),
    name: printerName,
    columns,
  });

  if (!result.ok) {
    deps.log.error(`Impression échouée : ${result.error ?? 'raison inconnue'}`);
    return { ok: false, code: 'PRINT_FAILED', message: result.error ?? 'Impression échouée.' };
  }

  deps.log.info(`Ticket ${receipt.ticket.number} imprimé (${result.bytesSent ?? 0} octets)`);
  if (unmapped.length > 0) {
    deps.log.warn(`Caractères substitués : ${unmapped.join(' ')}`);
  }

  return {
    ok: true,
    data: { ...base, ...pick(result), ...(unmapped.length > 0 ? { unmapped } : {}) },
  };
}

function pick(result: { jobId?: string; bytesSent?: number; unmapped?: string[] }): PrintTestData {
  return {
    ...(result.jobId === undefined ? {} : { jobId: result.jobId }),
    ...(result.bytesSent === undefined ? {} : { bytesSent: result.bytesSent }),
    ...(result.unmapped === undefined || result.unmapped.length === 0
      ? {}
      : { unmapped: result.unmapped }),
  };
}

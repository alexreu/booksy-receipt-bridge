import {
  BRIDGE_ERROR_MESSAGES,
  MAX_RESPONSE_BYTES,
  PROTOCOL_VERSION,
  type BridgeErrorCode,
  type ConfigData,
  type ListPrintersData,
  type NativeMessageType,
  type NativeResponse,
  type PingData,
  type StatusData,
} from '@brb/shared';
import { parseNativeMessage } from '@brb/shared/schemas';
import type { Printer, PrinterAdapter } from '@brb/printer';
import { BooksyParseError, parseBooksyReceipt } from '@brb/booksy-parser';
import { emitHtml, emitText } from '@brb/receipt-renderer';
import { buildTicketLayout } from '@brb/ticket-layout';
import { loadConfig, saveConfig, type ConfigState } from '../config/config.ts';
import type { Logger } from '../logging/logger.ts';
import { printReceipt, printTest } from '../printing/print.ts';
import { resolveSource } from '../printing/source.ts';

/** Message types this host implements. Everything else is refused explicitly. */
export const SUPPORTED: NativeMessageType[] = [
  'PING',
  'GET_STATUS',
  'LIST_PRINTERS',
  'GET_CONFIG',
  'SET_CONFIG',
  'PARSE_RECEIPT',
  'RENDER_RECEIPT',
  'PRINT_RECEIPT',
  'PRINT_TEST',
];

export interface HostContext {
  version: string;
  /** Mutable: SET_CONFIG replaces it so later messages see the new settings. */
  config: ConfigState;
  printer: PrinterAdapter;
  /** Name of the wired implementation, reported so the UI cannot be misled. */
  printerAdapter: string;
  log: Logger;
  configFile: string;
  /** Where recent prints are remembered; see printing/dedupe.ts. */
  historyPath: string;
}

/**
 * Turn one inbound value into one response.
 *
 * Pure with respect to the transport: it takes a parsed value and returns an
 * object, so every branch is testable without a pipe. It never throws - a host
 * that dies on a bad message looks to the extension exactly like a host that is
 * not installed.
 */
export async function dispatch(raw: unknown, context: HostContext): Promise<NativeResponse> {
  const id = extractId(raw);

  const parsed = parseNativeMessage(raw);
  if (!parsed.ok) {
    context.log.warn(`Message refusé : ${parsed.issues.join(' | ')}`);
    return failure(id, 'INVALID_MESSAGE', parsed.issues.join(' | '));
  }

  const message = parsed.message;
  if (!SUPPORTED.includes(message.type)) {
    context.log.info(`${message.type} n'est pas implémenté par cette version.`);
    return failure(
      message.id,
      'NOT_IMPLEMENTED',
      `${message.type} arrivera dans une version ultérieure du service.`,
    );
  }

  try {
    switch (message.type) {
      case 'PING': {
        const data: PingData = {
          status: 'ready',
          version: context.version,
          protocolVersion: PROTOCOL_VERSION,
        };
        return { id: message.id, success: true, data };
      }
      case 'GET_STATUS': {
        return { id: message.id, success: true, data: await status(context) };
      }

      case 'LIST_PRINTERS': {
        const data: ListPrintersData = {
          printers: await context.printer.list(),
          adapter: context.printerAdapter,
        };
        return { id: message.id, success: true, data };
      }

      case 'GET_CONFIG': {
        return { id: message.id, success: true, data: configData(context) };
      }

      case 'SET_CONFIG': {
        saveConfig(context.configFile, message.payload);
        // Re-read rather than trust the merge: what the next message sees must
        // be what is actually on disk.
        context.config = loadConfig(context.configFile);
        context.log.info('Configuration mise à jour');
        return { id: message.id, success: true, data: configData(context) };
      }

      case 'PARSE_RECEIPT': {
        const source = await resolveSource(message.payload.source, {
          allowedDirs: context.config.config.printing.allowedDirs,
        });
        if (!source.ok) {
          return failure(message.id, source.code, source.message);
        }
        try {
          const parsed = await parseBooksyReceipt(source.bytes);
          context.log.info(
            `Reçu lu, ticket ${parsed.receipt.ticket.number}, confiance ${parsed.confidence}`,
          );
          return { id: message.id, success: true, data: parsed };
        } catch (error) {
          return parseFailure(message.id, error, context);
        }
      }

      case 'RENDER_RECEIPT': {
        const source = await resolveSource(message.payload.source, {
          allowedDirs: context.config.config.printing.allowedDirs,
        });
        if (!source.ok) {
          return failure(message.id, source.code, source.message);
        }
        try {
          const { receipt, confidence, warnings } = await parseBooksyReceipt(source.bytes);
          const { printer } = context.config.config;
          const layout = buildTicketLayout(receipt, { columns: printer.columns });
          const content =
            message.payload.format === 'html'
              ? emitHtml(layout, {
                  paperWidth: printer.paperWidth,
                  printableWidth: printer.printableWidth,
                  title: `Reçu ${receipt.ticket.number}`,
                })
              : emitText(layout);
          return {
            id: message.id,
            success: true,
            data: {
              format: message.payload.format,
              content,
              ticketNumber: receipt.ticket.number,
              confidence,
              warnings,
            },
          };
        } catch (error) {
          return parseFailure(message.id, error, context);
        }
      }

      case 'PRINT_TEST': {
        const outcome = await printTest(printDeps(context));
        return outcome.ok
          ? { id: message.id, success: true, data: outcome.data }
          : failure(message.id, outcome.code, outcome.message);
      }

      case 'PRINT_RECEIPT': {
        const outcome = await printReceipt(message.payload, printDeps(context));
        return outcome.ok
          ? { id: message.id, success: true, data: outcome.data }
          : failure(message.id, outcome.code, outcome.message);
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    context.log.error(`${message.type} a échoué : ${detail}`);
    return failure(message.id, 'INVALID_MESSAGE', detail);
  }
}

function printDeps(context: HostContext): Parameters<typeof printTest>[0] {
  return {
    printer: context.printer,
    config: context.config.config,
    log: context.log,
    historyPath: context.historyPath,
  };
}

function configData(context: HostContext): ConfigData {
  return {
    config: context.config.config,
    present: context.config.present,
    ...(context.config.error === undefined ? {} : { error: context.config.error }),
  };
}

function parseFailure(id: string, error: unknown, context: HostContext): NativeResponse {
  if (error instanceof BooksyParseError) {
    context.log.warn(`${error.code} : ${error.message}`);
    return failure(id, error.code, error.message);
  }
  const detail = error instanceof Error ? error.message : String(error);
  context.log.error(`Lecture échouée : ${detail}`);
  return failure(id, 'PARSING_FAILED', detail);
}

async function status(context: HostContext): Promise<StatusData> {
  const configuredName = context.config.config.printer.name;
  const printerConfigured = configuredName !== '';

  let printers: Printer[] = [];
  try {
    printers = await context.printer.list();
  } catch (error) {
    context.log.warn(
      `Impossible de lister les imprimantes : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const printerFound =
    printerConfigured && printers.some((printer) => printer.name === configuredName);

  return {
    status: printerConfigured && printerFound && context.config.present ? 'ready' : 'degraded',
    version: context.version,
    protocolVersion: PROTOCOL_VERSION,
    printerConfigured,
    ...(printerConfigured ? { printerName: configuredName } : {}),
    printerFound,
    configPresent: context.config.present,
    printerAdapter: context.printerAdapter,
    supported: [...SUPPORTED],
  };
}

/**
 * Best-effort id recovery from an unvalidated value.
 *
 * A response with no id cannot be correlated by the extension, so pull one out
 * even from a message that failed validation.
 */
function extractId(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null) {
    const candidate = (raw as Record<string, unknown>)['id'];
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return 'unknown';
}

function failure(id: string, code: BridgeErrorCode, detail?: string): NativeResponse {
  return {
    id,
    success: false,
    error: {
      code,
      message: BRIDGE_ERROR_MESSAGES[code],
      ...(detail === undefined ? {} : { detail }),
    },
  };
}

/**
 * Guard the 1 MB cap Chrome puts on a host-to-extension message.
 *
 * A response over the cap is dropped by the browser with no error anywhere, so
 * it is replaced by one that says what happened.
 */
export function withinResponseLimit(response: NativeResponse): NativeResponse {
  const size = Buffer.byteLength(JSON.stringify(response), 'utf8');
  if (size <= MAX_RESPONSE_BYTES) return response;
  return failure(
    response.id,
    'INVALID_MESSAGE',
    `Réponse de ${size} octets, au-delà de la limite de ${MAX_RESPONSE_BYTES} imposée par Chrome.`,
  );
}

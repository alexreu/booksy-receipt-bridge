import {
  BRIDGE_ERROR_MESSAGES,
  MAX_RESPONSE_BYTES,
  PROTOCOL_VERSION,
  type BridgeErrorCode,
  type NativeMessageType,
  type NativeResponse,
  type PingData,
  type StatusData,
} from '@brb/shared';
import { parseNativeMessage } from '@brb/shared/schemas';
import type { Printer, PrinterAdapter } from '@brb/printer';
import type { ConfigState } from '../config/config.ts';
import type { Logger } from '../logging/logger.ts';

/** Message types this host implements. Everything else is refused explicitly. */
export const SUPPORTED: NativeMessageType[] = ['PING', 'GET_STATUS'];

export interface HostContext {
  version: string;
  config: ConfigState;
  printer: PrinterAdapter;
  /** Name of the wired implementation, reported so the UI cannot be misled. */
  printerAdapter: string;
  log: Logger;
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
      default:
        return failure(message.id, 'NOT_IMPLEMENTED', message.type);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    context.log.error(`${message.type} a échoué : ${detail}`);
    return failure(message.id, 'INVALID_MESSAGE', detail);
  }
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

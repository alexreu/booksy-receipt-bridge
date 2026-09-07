import {
  BRIDGE_ERROR_MESSAGES,
  type BridgeErrorCode,
  type NativeError,
  type NativeMessage,
  type NativeResponse,
} from '@brb/shared';
import { NATIVE_HOST_NAME } from './host-name.ts';

/**
 * The extension's view of the native host (plan section 48).
 *
 * Returns a NativeResponse rather than throwing, including for transport
 * failures. The caller then has one shape to handle: a host that is not
 * installed and a host that answered with an error are both "the request did
 * not succeed, here is why", and the UI needs the same code path for both.
 */
export interface NativeHostClient {
  send<T>(message: NativeMessage): Promise<NativeResponse<T>>;
}

/** `chrome.runtime.sendNativeMessage`, injected so this file can be tested. */
export type SendNativeMessage = (
  application: string,
  message: object,
) => Promise<unknown>;

export class ChromeNativeHostClient implements NativeHostClient {
  constructor(
    private readonly sendNativeMessage: SendNativeMessage,
    private readonly hostName: string = NATIVE_HOST_NAME,
  ) {}

  async send<T>(message: NativeMessage): Promise<NativeResponse<T>> {
    let raw: unknown;
    try {
      // One-shot rather than a long-lived port: an MV3 service worker is
      // evicted after about 30 seconds idle, so holding a connection open
      // across user actions is not something the worker can promise. The cost
      // is a process start per message, which is a few hundred milliseconds.
      raw = await this.sendNativeMessage(this.hostName, message);
    } catch (error) {
      return { id: message.id, success: false, error: transportError(error) };
    }

    const response = asResponse<T>(raw, message.id);
    if (response !== undefined) return response;
    return {
      id: message.id,
      success: false,
      error: {
        code: 'INVALID_MESSAGE',
        message: BRIDGE_ERROR_MESSAGES.INVALID_MESSAGE,
        detail: 'Le service a répondu dans un format inattendu.',
      },
    };
  }
}

/**
 * Classify a thrown transport failure.
 *
 * Chrome reports these as plain English strings with no code, so matching on
 * the text is the only option available. The raw text is always preserved in
 * `detail`, so a message Chrome rephrases still leaves something diagnosable
 * even when the classification falls through to the generic case.
 */
export function transportError(error: unknown): NativeError {
  const detail = error instanceof Error ? error.message : String(error);
  const text = detail.toLowerCase();

  const code = classify(text);
  return { code, message: BRIDGE_ERROR_MESSAGES[code], detail };
}

/**
 * Three outcomes, because they need three different things from the user:
 * install the service, re-register it with this extension's id, or report a
 * crash. Anything unrecognised is treated as "not installed", which is by far
 * the most common cause and the cheapest thing to check first.
 */
function classify(text: string): BridgeErrorCode {
  if (text.includes('not found') || text.includes('no such native')) {
    return 'NATIVE_HOST_NOT_FOUND';
  }
  if (text.includes('access') || text.includes('forbidden') || text.includes('not allowed')) {
    return 'NATIVE_HOST_FORBIDDEN';
  }
  if (text.includes('exited') || text.includes('crashed') || text.includes('closed')) {
    return 'NATIVE_HOST_CRASHED';
  }
  return 'NATIVE_HOST_NOT_FOUND';
}

/** Recognise a well-formed response without trusting its contents. */
function asResponse<T>(raw: unknown, expectedId: string): NativeResponse<T> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record['success'] !== 'boolean') return undefined;

  const id = typeof record['id'] === 'string' ? record['id'] : expectedId;
  return {
    id,
    success: record['success'],
    ...(record['data'] === undefined ? {} : { data: record['data'] as T }),
    ...(record['error'] === undefined ? {} : { error: record['error'] as NativeError }),
  };
}

/** Ids only need to be unique within a session; they correlate one reply. */
export function nextMessageId(): string {
  return `x-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

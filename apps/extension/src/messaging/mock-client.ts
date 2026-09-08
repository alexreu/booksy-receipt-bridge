import type { NativeMessage, NativeResponse } from '@brb/shared';
import type { NativeHostClient } from './client.ts';

export interface MockNativeHostClientOptions {
  /** Reply per message type. Anything unlisted gets a NOT_IMPLEMENTED error. */
  replies?: Partial<Record<NativeMessage['type'], unknown>>;
  /** Fail every send with this transport error, as an uninstalled host would. */
  failWith?: NativeResponse['error'];
}

/**
 * In-memory host (plan section 48).
 *
 * Used by the unit tests and by the Playwright build: a real Chrome cannot be
 * made to fake a native host, so the E2E path selects this implementation
 * instead of trying to install one.
 */
export interface MockNativeHost extends NativeHostClient {
  readonly sent: readonly NativeMessage[];
  readonly lastSent: NativeMessage | undefined;
}

/**
 * In-memory host (plan section 48).
 *
 * Used by the unit tests and by the Playwright build: a real Chrome cannot be
 * made to fake a native host, so the E2E path selects this implementation
 * instead of trying to install one.
 */
export function createMockNativeHostClient(
  options: MockNativeHostClientOptions = {},
): MockNativeHost {
  const sent: NativeMessage[] = [];

  const send = <T>(message: NativeMessage): Promise<NativeResponse<T>> => {
    sent.push(message);

    if (options.failWith !== undefined) {
      return Promise.resolve({ id: message.id, success: false, error: options.failWith });
    }

    const reply = options.replies?.[message.type];
    if (reply === undefined) {
      return Promise.resolve({
        id: message.id,
        success: false,
        error: {
          code: 'NOT_IMPLEMENTED',
          message: 'Non implémenté par ce host simulé.',
          detail: message.type,
        },
      });
    }
    return Promise.resolve({ id: message.id, success: true, data: reply as T });
  };

  return {
    send,
    get sent() {
      return sent;
    },
    get lastSent() {
      return sent[sent.length - 1];
    },
  };
}

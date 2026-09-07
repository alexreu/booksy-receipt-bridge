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
export class MockNativeHostClient implements NativeHostClient {
  readonly sent: NativeMessage[] = [];

  constructor(private readonly options: MockNativeHostClientOptions = {}) {}

  send<T>(message: NativeMessage): Promise<NativeResponse<T>> {
    this.sent.push(message);

    if (this.options.failWith !== undefined) {
      return Promise.resolve({
        id: message.id,
        success: false,
        error: this.options.failWith,
      });
    }

    const reply = this.options.replies?.[message.type];
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
  }

  get lastSent(): NativeMessage | undefined {
    return this.sent[this.sent.length - 1];
  }
}

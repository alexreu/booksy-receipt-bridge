import type {
  ConfigData,
  ListPrintersData,
  PingData,
  PrintTestData,
} from '@brb/shared';
import { nextMessageId, type NativeHostClient } from '../messaging/client.ts';
import {
  WRITING_KINDS,
  parseExtensionRequest,
  type ExtensionRequest,
  type ExtensionResponse,
} from '../messaging/protocol.ts';
import { resolveHostState } from '../messaging/state.ts';

export interface RouterSender {
  id?: string | undefined;
  /**
   * Origin of the sending context.
   *
   * This, not the presence of a tab, is what separates an extension page from a
   * content script. An extension page opened in a tab - which the options page
   * is, by `open_in_tab` - also carries a tab, so keying on that blocked the
   * options page from saving anything.
   */
  origin?: string | undefined;
  url?: string | undefined;
}

export interface RouterDeps {
  client: NativeHostClient;
  /** The extension's own id, to reject anything from elsewhere. */
  extensionId: string;
  log?: (message: string) => void;
}

/**
 * Handle one internal message.
 *
 * Extracted from the service worker so it can be tested without a browser: the
 * worker itself is then only `chrome.runtime.onMessage` wiring.
 *
 * Two checks guard the native channel. The sender's id must be this extension:
 * `onMessage` is reachable from this extension's content scripts, which run
 * alongside a web page, and without that check the worker is an open relay.
 * And a message carrying a tab is a content script, which gets the read-only
 * intents only - nothing in a page should be able to repoint the printer or
 * start a print job.
 */
export async function handleExtensionMessage(
  raw: unknown,
  sender: RouterSender,
  deps: RouterDeps,
): Promise<ExtensionResponse> {
  if (sender.id !== deps.extensionId) {
    deps.log?.(`Message rejeté : expéditeur inattendu ${String(sender.id)}`);
    return { kind: 'ERROR', message: 'Expéditeur non autorisé.' };
  }

  const request = parseExtensionRequest(raw);
  if (request === undefined) {
    deps.log?.('Message interne inconnu rejeté');
    return { kind: 'ERROR', message: 'Message interne inconnu.' };
  }

  if (!isExtensionPage(sender, deps.extensionId) && WRITING_KINDS.includes(request.kind)) {
    deps.log?.(`${request.kind} refusé à un contexte de page : ${String(sender.origin)}`);
    return { kind: 'ERROR', message: 'Action non autorisée depuis une page.' };
  }

  return dispatch(request, deps);
}

/**
 * Did this come from one of the extension's own pages?
 *
 * A content script's origin is the web page it runs in; an extension page's is
 * `chrome-extension://<id>`. Only the latter may change settings or start a
 * print job.
 */
export function isExtensionPage(sender: RouterSender, extensionId: string): boolean {
  const expected = `chrome-extension://${extensionId}`;
  if (sender.origin !== undefined && sender.origin !== '') return sender.origin === expected;
  // Older Chrome builds omit `origin`; the page URL carries the same fact.
  if (sender.url !== undefined && sender.url !== '') return sender.url.startsWith(`${expected}/`);
  // Neither present: a message from a background context, which is ours.
  return true;
}

async function dispatch(
  request: ExtensionRequest,
  deps: RouterDeps,
): Promise<ExtensionResponse> {
  switch (request.kind) {
    case 'GET_HOST_STATE':
      return { kind: 'HOST_STATE', state: await resolveHostState(deps.client) };

    case 'PING_HOST': {
      const ping = await deps.client.send<PingData>({ id: nextMessageId(), type: 'PING' });
      if (!ping.success) {
        return { kind: 'ERROR', message: ping.error?.message ?? 'Le service ne répond pas.' };
      }
      return { kind: 'HOST_STATE', state: await resolveHostState(deps.client) };
    }

    case 'LIST_PRINTERS': {
      const response = await deps.client.send<ListPrintersData>({
        id: nextMessageId(),
        type: 'LIST_PRINTERS',
      });
      if (!response.success || response.data === undefined) {
        return { kind: 'ERROR', message: response.error?.message ?? 'Liste indisponible.' };
      }
      return {
        kind: 'PRINTERS',
        printers: response.data.printers,
        adapter: response.data.adapter,
      };
    }

    case 'GET_CONFIG':
    case 'SET_CONFIG': {
      const response = await deps.client.send<ConfigData>(
        request.kind === 'GET_CONFIG'
          ? { id: nextMessageId(), type: 'GET_CONFIG' }
          : { id: nextMessageId(), type: 'SET_CONFIG', payload: request.patch },
      );
      if (!response.success || response.data === undefined) {
        return { kind: 'ERROR', message: response.error?.message ?? 'Configuration indisponible.' };
      }
      return {
        kind: 'CONFIG',
        config: response.data.config,
        present: response.data.present,
        ...(response.data.error === undefined ? {} : { error: response.data.error }),
      };
    }

    case 'PRINT_TEST': {
      const response = await deps.client.send<PrintTestData>({
        id: nextMessageId(),
        type: 'PRINT_TEST',
      });
      if (!response.success) {
        return { kind: 'ERROR', message: response.error?.message ?? 'Impression échouée.' };
      }
      return { kind: 'PRINTED', data: response.data ?? {} };
    }
  }
}

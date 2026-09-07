import type { NativeHostClient } from '../messaging/client.ts';
import { parseExtensionRequest, type ExtensionResponse } from '../messaging/protocol.ts';
import { nextMessageId } from '../messaging/client.ts';
import { resolveHostState } from '../messaging/state.ts';
import type { PingData } from '@brb/shared';

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
 * The sender check matters. `onMessage` is reachable from this extension's own
 * pages and from its content scripts, and a content script runs alongside a web
 * page. Verifying the sender's id keeps the worker from acting as an open relay
 * to the native host for anything that manages to post into it.
 */
export async function handleExtensionMessage(
  raw: unknown,
  sender: { id?: string | undefined },
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
  }
}

import type {
  ConfigData,
  ListPrintersData,
  PingData,
  PrintReceiptData,
  PrintTestData,
} from '@brb/shared';
import type { DownloadCandidate } from '../downloads/filter.ts';
import {
  forgetDetected,
  readDetected,
  updateDetected,
  type SessionStorage,
} from '../downloads/store.ts';
import { reconcileDownloads } from '../downloads/watcher.ts';
import { nextMessageId, type NativeHostClient } from '../messaging/client.ts';
import {
  WRITING_KINDS,
  parseExtensionRequest,
  type ExtensionRequest,
  type ExtensionResponse,
} from '../messaging/protocol.ts';
import type { ActiveTabPdf } from '../messaging/protocol.ts';
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
  storage: SessionStorage;
  /**
   * What the active tab is showing, and its bytes.
   *
   * Resolved by the worker, never supplied by a caller: nothing outside the
   * worker gets to name the document that will be printed.
   */
  activeTabPdf?: () => Promise<{ pdf: ActiveTabPdf | null; reason?: string }>;
  fetchActiveTab?: () => Promise<Uint8Array>;
  /**
   * Recent downloads, newest first. Given, LIST_DETECTED catches up on any
   * detection lost to the service worker being evicted mid-call.
   */
  recentDownloads?: (limit: number) => Promise<DownloadCandidate[]>;
  /** Look one download up by id, for that same recovery pass. */
  lookupDownload?: (downloadId: number) => Promise<DownloadCandidate | undefined>;
  /** Show how many detected receipts still await a decision. */
  setBadge?: (count: number) => void;
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

    case 'LIST_DETECTED': {
      if (deps.recentDownloads === undefined || deps.lookupDownload === undefined) {
        return { kind: 'DETECTED', receipts: await readDetected(deps.storage) };
      }
      const receipts = await reconcileDownloads({
        client: deps.client,
        storage: deps.storage,
        lookup: deps.lookupDownload,
        recent: deps.recentDownloads,
        ...(deps.setBadge === undefined ? {} : { setBadge: deps.setBadge }),
        ...(deps.log === undefined ? {} : { log: deps.log }),
      });
      return { kind: 'DETECTED', receipts };
    }

    case 'DISMISS_DETECTED': {
      const receipts = await forgetDetected(deps.storage, request.downloadId);
      deps.setBadge?.(pending(receipts));
      return { kind: 'DETECTED', receipts };
    }

    case 'GET_ACTIVE_TAB': {
      if (deps.activeTabPdf === undefined) return { kind: 'ACTIVE_TAB', pdf: null };
      const result = await deps.activeTabPdf();
      return {
        kind: 'ACTIVE_TAB',
        pdf: result.pdf,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
    }

    case 'PRINT_ACTIVE_TAB': {
      if (deps.fetchActiveTab === undefined) {
        return { kind: 'ERROR', message: 'Aucun onglet à imprimer.' };
      }

      let bytes: Uint8Array;
      try {
        bytes = await deps.fetchActiveTab();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log?.(`Récupération du PDF échouée : ${message}`);
        return { kind: 'ERROR', message: 'Le PDF de cet onglet n’a pas pu être lu.' };
      }

      const response = await deps.client.send<PrintReceiptData>({
        id: nextMessageId(),
        type: 'PRINT_RECEIPT',
        // Bytes rather than a path: a PDF shown in a tab is not a local file
        // (plan section 2.3).
        payload: { source: { kind: 'bytes', base64: toBase64(bytes) }, trigger: 'user' },
      });
      if (!response.success || response.data === undefined) {
        return { kind: 'ERROR', message: response.error?.message ?? 'Impression échouée.' };
      }
      return { kind: 'PRINTED_RECEIPT', data: response.data };
    }

    case 'PRINT_DETECTED': {
      // The path comes from what the worker itself recorded, never from the
      // caller: a caller names a download id, and nothing else.
      const known = (await readDetected(deps.storage)).find(
        (entry) => entry.downloadId === request.downloadId,
      );
      if (known === undefined) {
        return { kind: 'ERROR', message: 'Ce reçu n’est plus disponible.' };
      }

      const response = await deps.client.send<PrintReceiptData>({
        id: nextMessageId(),
        type: 'PRINT_RECEIPT',
        payload: { source: { kind: 'path', path: known.path }, trigger: 'user' },
      });
      if (!response.success || response.data === undefined) {
        return { kind: 'ERROR', message: response.error?.message ?? 'Impression échouée.' };
      }

      const receipts = await updateDetected(deps.storage, request.downloadId, {
        printedAt: Date.now(),
      });
      deps.setBadge?.(pending(receipts));
      return { kind: 'PRINTED_RECEIPT', data: response.data };
    }
  }
}

function pending(receipts: readonly { printedAt?: number }[]): number {
  return receipts.filter((receipt) => receipt.printedAt === undefined).length;
}

/** Chunked, because spreading a large array into String.fromCharCode overflows. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 8192;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

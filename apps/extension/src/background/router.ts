import type {
  ConfigData,
  RenderedReceipt,
  UpdateCheck,
  UpdateDownload,
  ListPrintersData,
  PingData,
  PrintReceiptData,
} from '@brb/shared';
import type { SessionStorage } from '../storage.ts';
import { localPathOf } from '../tabs/active-pdf.ts';
import {
  addPending,
  dropPending,
  findPending,
  previewId,
  readPending,
} from '../preview/pending.ts';
import { nextMessageId, type NativeHostClient } from '../messaging/client.ts';
import {
  PAGE_ALLOWED_KINDS,
  parseExtensionRequest,
  type ExtensionRequest,
  type ExtensionResponse,
} from '../messaging/protocol.ts';
import type { Clock } from '@brb/shared';
import type { ReceiptSource } from '@brb/shared';
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
  /** The one place time enters the worker. */
  clock: Clock;
  /** Opens the approval page. Injected so a test opens no tab. */
  openPreview?: (id: string) => Promise<void> | void;
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
 * And a sender that is not one of this extension's own pages gets only the
 * allowlisted intents - nothing in a page should repoint the printer, start a
 * job, or read a receipt's contents.
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

  // Default-deny: a page gets only what is on the allowlist, so an intent
  // added later is refused there until someone lists it deliberately.
  if (!isExtensionPage(sender, deps.extensionId) && !PAGE_ALLOWED_KINDS.includes(request.kind)) {
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

    case 'GET_ACTIVE_TAB': {
      if (deps.activeTabPdf === undefined) return { kind: 'ACTIVE_TAB', pdf: null };
      const result = await deps.activeTabPdf();
      return {
        kind: 'ACTIVE_TAB',
        pdf: result.pdf,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
    }

    case 'CHECK_UPDATE': {
      const response = await deps.client.send<UpdateCheck>({
        id: nextMessageId(),
        type: 'CHECK_UPDATE',
      });
      if (!response.success || response.data === undefined) {
        return { kind: 'ERROR', message: response.error?.message ?? 'Vérification impossible.' };
      }
      return { kind: 'UPDATE', check: response.data };
    }

    case 'DOWNLOAD_UPDATE': {
      const response = await deps.client.send<UpdateDownload>({
        id: nextMessageId(),
        type: 'DOWNLOAD_UPDATE',
      });
      if (!response.success || response.data === undefined) {
        return { kind: 'ERROR', message: response.error?.message ?? 'Téléchargement impossible.' };
      }
      return { kind: 'UPDATE_DOWNLOADED', download: response.data };
    }

    case 'PREPARE_PREVIEW': {
      // Captured once, up front: what is approved must be what is printed.
      const captured = await capture(deps);
      if (!captured.ok) return { kind: 'ERROR', message: captured.error };

      const existing = await readPending(deps.storage);
      const id = previewId(deps.clock, existing);
      await addPending(deps.storage, {
        id,
        source: captured.source,
        ...(captured.label === undefined ? {} : { label: captured.label }),
        createdAt: deps.clock(),
      });
      await deps.openPreview?.(id);
      return {
        kind: 'PREVIEW_READY',
        id,
        ...(captured.label === undefined ? {} : { label: captured.label }),
      };
    }

    case 'RENDER_PREVIEW': {
      const pending = await findPending(deps.storage, request.id);
      if (pending === undefined) {
        return { kind: 'ERROR', message: 'Cet aperçu a expiré.' };
      }
      const response = await deps.client.send<RenderedReceipt>({
        id: nextMessageId(),
        type: 'RENDER_RECEIPT',
        payload: { source: pending.source, format: 'svg' },
      });
      if (!response.success || response.data === undefined) {
        return { kind: 'ERROR', message: response.error?.message ?? 'Aperçu indisponible.' };
      }
      return {
        kind: 'PREVIEW',
        rendered: response.data,
        // The label travels with the render, so the page never has to be told
        // what it is showing: it only ever holds an id.
        ...(pending.label === undefined ? {} : { label: pending.label }),
      };
    }

    case 'PRINT_PREVIEW': {
      const pending = await findPending(deps.storage, request.id);
      if (pending === undefined) {
        return { kind: 'ERROR', message: 'Cet aperçu a expiré.' };
      }
      const response = await deps.client.send<PrintReceiptData>({
        id: nextMessageId(),
        type: 'PRINT_RECEIPT',
        payload: {
          // The same source the preview was rendered from.
          source: pending.source,
          trigger: 'user',
          ...(request.printerName === undefined ? {} : { printerName: request.printerName }),
        },
      });
      if (!response.success || response.data === undefined) {
        return { kind: 'ERROR', message: response.error?.message ?? 'Impression échouée.' };
      }
      // Only once it printed: a failure must leave the preview open to retry.
      await dropPending(deps.storage, request.id);
      return { kind: 'PRINTED_RECEIPT', data: response.data };
    }

    case 'DISCARD_PREVIEW': {
      await dropPending(deps.storage, request.id);
      return { kind: 'PREVIEW_READY', id: request.id };
    }

  }
}

/**
 * Resolve what the tab is showing into something the host can read, once.
 *
 * TWO ROUTES, ONE RULE: the browser never reads a local file. A PDF served over
 * http(s) is fetched here and travels as bytes, because there is no path to
 * re-read. A `file:` tab travels as its PATH, and the service opens it - it
 * re-validates that path against its allowed directories every time, resolving
 * symlinks first (plan section 23). Either way the same source is used for the
 * preview and for the print, so what was approved is what goes to the printer.
 */
async function capture(
  deps: RouterDeps,
): Promise<
  { ok: true; source: ReceiptSource; label?: string } | { ok: false; error: string }
> {
  // Read here, not sent by the caller: nothing outside the worker names the
  // document that will be printed.
  const active = await deps.activeTabPdf?.();
  const pdf = active?.pdf ?? null;
  const label = pdf === null ? undefined : pdf.name;

  const path = pdf === null ? undefined : localPathOf(pdf.url);
  if (path !== undefined) {
    return { ok: true, source: { kind: 'path', path }, ...(label === undefined ? {} : { label }) };
  }

  if (deps.fetchActiveTab === undefined) {
    return { ok: false, error: 'Aucun onglet à imprimer.' };
  }
  try {
    const bytes = await deps.fetchActiveTab();
    return {
      ok: true,
      source: { kind: 'bytes', base64: toBase64(bytes) },
      ...(label === undefined ? {} : { label }),
    };
  } catch (error) {
    deps.log?.(
      `Capture de l'onglet échouée : ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, error: "Le PDF de cet onglet n'a pas pu être lu." };
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 8192;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

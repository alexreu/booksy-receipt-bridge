/**
 * Service worker.
 *
 * The only part of the extension that talks to the native host (plan section 9):
 *
 *   Booksy DOM -> content script -> chrome.runtime.sendMessage
 *              -> this worker    -> chrome.runtime.sendNativeMessage -> host
 *
 * It holds no state in memory. An MV3 worker is evicted after about 30 seconds
 * idle, so anything it remembered would vanish unpredictably: the settings live
 * in the host (plan section 18), a receipt awaiting approval lives in session
 * storage, and every native call is one-shot.
 */
import { systemClock } from '@brb/shared';
import { createChromeNativeHostClient } from '../messaging/client.ts';
import type { SessionStorage } from '../storage.ts';
import { activeTabResultOf, type ActiveTabResult } from '../tabs/active-pdf.ts';
import { handleExtensionMessage } from './router.ts';

const client = createChromeNativeHostClient((application, message) =>
  chrome.runtime.sendNativeMessage(application, message),
);

/**
 * Session storage rather than local: it holds a receipt waiting to be approved,
 * which has no business surviving a browser restart.
 */
const storage: SessionStorage = {
  get: (key) => chrome.storage.session.get(key),
  set: (items) => chrome.storage.session.set(items),
};

const log = (message: string): void => {
  console.info('[brb]', message);
};

/**
 * The PDF the user is looking at.
 *
 * Read here rather than passed in from the popup: the worker resolving the tab
 * itself means there is no address from a caller to validate, and nothing a
 * page could nominate for printing.
 */
async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function activeTabPdf(): Promise<ActiveTabResult> {
  const tab = await activeTab();
  return activeTabResultOf(tab === undefined ? undefined : { url: tab.url, title: tab.title });
}

/** A receipt PDF is small; this is a generous ceiling. */
const MAX_TAB_PDF_BYTES = 20 * 1024 * 1024;

async function fetchActiveTab(): Promise<Uint8Array> {
  const { pdf, reason } = await activeTabPdf();
  if (pdf === null) {
    throw new Error(
      reason === 'no-permission'
        ? "L'accès à cet onglet n'a pas été accordé."
        : "L'onglet actif n'affiche pas de PDF.",
    );
  }

  // `activeTab` grants access to this tab's origin for as long as the user's
  // click lasts, which is why no site appears in host_permissions.
  const response = await fetch(pdf.url, { credentials: 'include' });
  if (!response.ok) throw new Error(`Réponse ${response.status} pour ce PDF.`);

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_TAB_PDF_BYTES) {
    throw new Error(`PDF de ${buffer.byteLength} octets, au-delà de la limite.`);
  }
  return new Uint8Array(buffer);
}

/**
 * Open the approval page.
 *
 * A tab rather than a popup window: the ticket is tall, and a tab survives the
 * extension popup closing - which it does the moment focus moves.
 */
async function openPreview(id: string): Promise<void> {
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`preview/index.html?id=${encodeURIComponent(id)}`),
  });
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  handleExtensionMessage(
    raw,
    { id: sender.id, origin: sender.origin, url: sender.url },
    {
      client,
      extensionId: chrome.runtime.id,
      storage,
      activeTabPdf,
      fetchActiveTab,
      openPreview,
      log,
      clock: systemClock,
    },
  )
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({
        kind: 'ERROR',
        message: error instanceof Error ? error.message : String(error),
      });
    });

  // Keep the message channel open for the async reply.
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  log(`installé ${details.reason} | id ${chrome.runtime.id}`);
});

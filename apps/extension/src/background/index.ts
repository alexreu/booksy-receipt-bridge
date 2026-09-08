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
 * in the host (plan section 18), detected receipts live in session storage, and
 * every native call is one-shot.
 */
import { systemClock } from '@brb/shared';
import { createChromeNativeHostClient } from '../messaging/client.ts';
import type { DownloadCandidate } from '../downloads/filter.ts';
import type { SessionStorage } from '../downloads/store.ts';
import { handleFinishedDownload } from '../downloads/watcher.ts';
import { activeTabResultOf, type ActiveTabResult } from '../tabs/active-pdf.ts';
import { handleExtensionMessage } from './router.ts';

const client = createChromeNativeHostClient((application, message) =>
  chrome.runtime.sendNativeMessage(application, message),
);

/**
 * Session storage rather than local: the list is about what just happened, and
 * it should not survive a browser restart.
 */
const storage: SessionStorage = {
  get: (key) => chrome.storage.session.get(key),
  set: (items) => chrome.storage.session.set(items),
};

function setBadge(count: number): void {
  void chrome.action.setBadgeText({ text: count === 0 ? '' : String(count) });
  void chrome.action.setBadgeBackgroundColor({ color: '#1a7f4b' });
}

const log = (message: string): void => {
  console.info('[brb]', message);
};

function toCandidate(item: chrome.downloads.DownloadItem): DownloadCandidate {
  return {
    id: item.id,
    filename: item.filename,
    url: item.url,
    referrer: item.referrer,
    state: item.state,
    exists: item.exists,
    mime: item.mime,
  };
}

async function lookupDownload(downloadId: number): Promise<DownloadCandidate | undefined> {
  const [item] = await chrome.downloads.search({ id: downloadId });
  return item === undefined ? undefined : toCandidate(item);
}

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

async function recentDownloads(limit: number): Promise<DownloadCandidate[]> {
  const items = await chrome.downloads.search({ limit, orderBy: ['-startTime'] });
  return items.map(toCandidate);
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  handleExtensionMessage(
    raw,
    { id: sender.id, origin: sender.origin, url: sender.url },
    {
      client,
      extensionId: chrome.runtime.id,
      storage,
      recentDownloads,
      lookupDownload,
      activeTabPdf,
      fetchActiveTab,
      setBadge,
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

/**
 * Watch for finished downloads (plan section 19).
 *
 * `onChanged` rather than `onCreated`: a download must be complete before the
 * file can be read, and the change event is the only one that says so. It
 * carries no filename, so the item is looked up by id.
 */
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current !== 'complete') return;
  // Best effort. The worker can be evicted before the host answers, and the
  // host process dies with it - so LIST_DETECTED reconciles rather than
  // trusting this to finish.
  void handleFinishedDownload(delta.id, {
    client,
    storage,
    lookup: lookupDownload,
    setBadge,
    log,
    now: systemClock,
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  log(`installé ${details.reason} | id ${chrome.runtime.id}`);
});

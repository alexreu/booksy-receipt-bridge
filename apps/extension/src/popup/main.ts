/**
 * Popup.
 *
 * Thin by design: it asks the service worker for the host state, hands it to
 * `popupView` and lets `applyPopupView` write it out. The popup never talks to
 * the native host itself - the worker owns that channel (plan section 9).
 */
import type { ExtensionRequest, ExtensionResponse } from '../messaging/protocol.ts';
import type { HostState } from '../messaging/state.ts';
import { applyActiveTabPdf, applyPopupView, applyUpdateView } from './dom.ts';
import { popupView } from './render.ts';
import { downloadedView, updateView } from './update.ts';

async function ask(request: ExtensionRequest): Promise<ExtensionResponse> {
  const response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse | undefined;
  return response ?? { kind: 'ERROR', message: 'Le service ne répond pas.' };
}

function unavailable(message: string): HostState {
  return {
    kind: 'unavailable',
    error: { code: 'NATIVE_HOST_NOT_FOUND', message },
  };
}

async function hostState(): Promise<HostState> {
  const response = await ask({ kind: 'GET_HOST_STATE' });
  if (response.kind === 'HOST_STATE') return response.state;
  return unavailable(response.kind === 'ERROR' ? response.message : 'Réponse inattendue.');
}

/**
 * Report the outcome of an action.
 *
 * Its own element, not the view's hint: printing re-renders the view right
 * after, and sharing an element meant the message was overwritten before it
 * could be read.
 */
function setFeedback(message: string): void {
  const feedback = document.getElementById('feedback');
  if (feedback !== null) feedback.textContent = message;
}

/**
 * Whether printing is possible at all right now.
 *
 * A connected service is the whole condition: the printer is chosen in the
 * preview, so a poste with no default printer can still print.
 */
function canPrint(state: HostState): boolean {
  return state.kind === 'connected';
}

async function refreshActiveTab(state?: HostState): Promise<void> {
  const resolved = state ?? (await hostState());
  const response = await ask({ kind: 'GET_ACTIVE_TAB' });
  if (response.kind === 'ACTIVE_TAB') {
    applyActiveTabPdf(document, response.pdf, canPrint(resolved), response.reason);
  }
}

async function printActiveTab(): Promise<void> {
  const button = document.getElementById('print-tab') as HTMLButtonElement | null;
  if (button !== null) button.disabled = true;

  setFeedback('Préparation de l’aperçu…');
  const response = await ask({ kind: 'PREPARE_PREVIEW', source: { kind: 'activeTab' } });
  setFeedback(
    response.kind === 'PREVIEW_READY'
      ? 'Aperçu ouvert dans un onglet.'
      : response.kind === 'ERROR'
        ? response.message
        : 'Aperçu indisponible.',
  );
  await refreshActiveTab();
}

async function refresh(): Promise<void> {
  setFeedback('');
  applyPopupView(document, popupView({ kind: 'checking' }));
  // One host round trip feeds both the checklist and the tab section.
  const state = await hostState();
  applyPopupView(document, popupView(state));
  await refreshActiveTab(state);
}

/**
 * Only ever on a click.
 *
 * There is no check at startup and no timer: AC19 means the extension must not
 * reach the network unless the user asks it to.
 */
async function checkUpdate(): Promise<void> {
  setFeedback('');
  applyUpdateView(document, { summary: 'Vérification…', canDownload: false });
  const response = await ask({ kind: 'CHECK_UPDATE' });
  if (response.kind === 'UPDATE') {
    applyUpdateView(document, updateView(response.check));
    return;
  }
  applyUpdateView(document, {
    summary: 'Vérification impossible.',
    canDownload: false,
    ...(response.kind === 'ERROR' ? { detail: response.message } : {}),
  });
}

async function downloadUpdate(): Promise<void> {
  const button = document.getElementById('download-update') as HTMLButtonElement | null;
  if (button !== null) button.disabled = true;
  setFeedback('Téléchargement…');

  const response = await ask({ kind: 'DOWNLOAD_UPDATE' });
  setFeedback(
    response.kind === 'UPDATE_DOWNLOADED'
      ? downloadedView(response.download)
      : response.kind === 'ERROR'
        ? response.message
        : 'Réponse inattendue.',
  );
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('retry')?.addEventListener('click', () => {
    void refresh();
  });
  document.getElementById('print-tab')?.addEventListener('click', () => {
    void printActiveTab();
  });
  document.getElementById('check-update')?.addEventListener('click', () => {
    void checkUpdate();
  });
  document.getElementById('download-update')?.addEventListener('click', () => {
    void downloadUpdate();
  });
  document.getElementById('settings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  void refresh();
});

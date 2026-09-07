/**
 * Popup.
 *
 * Thin by design: it asks the service worker for the host state, hands it to
 * `popupView` and lets `applyPopupView` write it out. The popup never talks to
 * the native host itself - the worker owns that channel (plan section 9).
 */
import type { ExtensionRequest, ExtensionResponse } from '../messaging/protocol.ts';
import type { HostState } from '../messaging/state.ts';
import { detectedRows } from './detected.ts';
import { applyDetectedRows, applyPopupView } from './dom.ts';
import { popupView } from './render.ts';

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

async function refreshDetected(): Promise<void> {
  const response = await ask({ kind: 'LIST_DETECTED' });
  if (response.kind === 'DETECTED') {
    applyDetectedRows(document, detectedRows(response.receipts));
  }
}

async function refresh(): Promise<void> {
  setFeedback('');
  applyPopupView(document, popupView({ kind: 'checking' }));
  // Both, in parallel: the downloaded-receipt list has its own source and does
  // not depend on the host state resolving first.
  await Promise.all([
    hostState().then((state) => applyPopupView(document, popupView(state))),
    refreshDetected(),
  ]);
}

async function printDetected(downloadId: number): Promise<void> {
  setFeedback('Impression…');
  const response = await ask({ kind: 'PRINT_DETECTED', downloadId });

  if (response.kind === 'PRINTED_RECEIPT') {
    const { ticketNumber, duplicate, warnings } = response.data;
    setFeedback(
      duplicate === true
        ? `Ticket ${ticketNumber} déjà imprimé à l’instant, rien envoyé.`
        : warnings.length === 0
          ? `Ticket ${ticketNumber} imprimé.`
          : `Ticket ${ticketNumber} imprimé, ${warnings.length} anomalie(s) signalée(s).`,
    );
  } else {
    setFeedback(response.kind === 'ERROR' ? response.message : 'Réponse inattendue.');
  }
  await refreshDetected();
}

async function dismissDetected(downloadId: number): Promise<void> {
  const response = await ask({ kind: 'DISMISS_DETECTED', downloadId });
  if (response.kind === 'DETECTED') {
    applyDetectedRows(document, detectedRows(response.receipts));
  }
}

async function printTest(): Promise<void> {
  const button = document.getElementById('print-test') as HTMLButtonElement | null;
  if (button !== null) button.disabled = true;
  setFeedback('Envoi du ticket de test…');

  const response = await ask({ kind: 'PRINT_TEST' });
  if (response.kind === 'PRINTED') {
    const substituted = response.data.unmapped ?? [];
    setFeedback(
      substituted.length === 0
        ? 'Ticket de test envoyé.'
        : `Ticket de test envoyé. Caractères remplacés : ${substituted.join(' ')}`,
    );
  } else {
    setFeedback(response.kind === 'ERROR' ? response.message : 'Réponse inattendue.');
  }

  // Re-read the state rather than guess: a failed print may mean the printer
  // has gone, and the checklist should say so. This must not clobber the
  // message above, which is why it lives in its own element.
  applyPopupView(document, popupView(await hostState()));
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('retry')?.addEventListener('click', () => {
    void refresh();
  });
  document.getElementById('print-test')?.addEventListener('click', () => {
    void printTest();
  });
  document.getElementById('settings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // One delegated listener: the rows are rebuilt on every refresh, and inline
  // handlers are forbidden by the manifest V3 content security policy.
  document.getElementById('detected-list')?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const downloadId = Number(target.dataset['downloadId']);
    if (!Number.isInteger(downloadId)) return;

    if (target.dataset['action'] === 'print-detected') void printDetected(downloadId);
    if (target.dataset['action'] === 'dismiss-detected') void dismissDetected(downloadId);
  });

  void refresh();
});

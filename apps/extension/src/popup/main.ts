/**
 * Popup.
 *
 * Thin by design: it asks the service worker for the host state, hands it to
 * `popupView` and lets `applyPopupView` write it out. The popup never talks to
 * the native host itself - the worker owns that channel (plan section 9).
 */
import type { ExtensionRequest, ExtensionResponse } from '../messaging/protocol.ts';
import type { HostState } from '../messaging/state.ts';
import { applyPopupView } from './dom.ts';
import { popupView } from './render.ts';

async function ask(request: ExtensionRequest): Promise<HostState> {
  const response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse | undefined;
  if (response === undefined || response.kind === 'ERROR') {
    return {
      kind: 'unavailable',
      error: {
        code: 'NATIVE_HOST_NOT_FOUND',
        message: response?.message ?? 'Le service ne répond pas.',
      },
    };
  }
  return response.state;
}

async function refresh(): Promise<void> {
  applyPopupView(document, popupView({ kind: 'checking' }));
  applyPopupView(document, popupView(await ask({ kind: 'GET_HOST_STATE' })));
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('retry')?.addEventListener('click', () => {
    void refresh();
  });
  void refresh();
});

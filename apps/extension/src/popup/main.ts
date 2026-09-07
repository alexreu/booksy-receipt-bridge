/**
 * Popup entry point.
 *
 * Phase 0 scope: report what the extension knows about itself. The native host
 * status arrives in phase 5. No React - plan section 6 allows it, but four entry
 * points of near-static markup do not need a framework yet.
 *
 * The extension ID is shown because the installer needs it: the native host
 * manifest lists exact origins and wildcards are forbidden (plan section 11), so
 * whoever registers the host has to read this value off a real install.
 */

interface PopupElements {
  status: HTMLElement;
  hint: HTMLElement;
}

function elements(): PopupElements | null {
  const status = document.querySelector<HTMLElement>('.status');
  const hint = document.querySelector<HTMLElement>('.hint');
  if (status === null || hint === null) return null;
  return { status, hint };
}

function render(): void {
  const found = elements();
  if (found === null) return;

  const { version } = chrome.runtime.getManifest();
  found.status.textContent = 'Service : non vérifié';
  found.status.dataset.state = 'unknown';
  found.hint.textContent = `Version ${version} · ID ${chrome.runtime.id}`;
}

document.addEventListener('DOMContentLoaded', render);

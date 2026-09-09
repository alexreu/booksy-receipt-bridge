import type { ActiveTabPdf } from '../messaging/protocol.ts';
import type { UpdateView } from './update.ts';
import type { PopupView } from './render.ts';

/**
 * Write a PopupView into the popup's markup.
 *
 * Split from main.ts so it can be exercised under jsdom against the real
 * index.html. That matters more than it looks: `render.ts` is pure and well
 * covered, but the step that actually reaches the user is this one, and a
 * renamed id here fails silently in a browser with nothing but an empty popup
 * to show for it.
 */
export function applyPopupView(document: Document, view: PopupView): void {
  const element = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`élément #${id} absent du popup`);
    return found as T;
  };

  const summary = element('summary');
  summary.textContent = view.summary;
  summary.dataset['state'] = view.state;

  const checklist = element<HTMLUListElement>('checklist');
  checklist.replaceChildren(
    ...view.checklist.map((item) => {
      const li = document.createElement('li');
      li.dataset['ok'] = String(item.ok);

      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = item.ok ? '✓' : '✕';

      const label = document.createElement('span');
      label.textContent = item.label;

      li.append(mark, label);
      if (item.detail !== undefined) {
        const detail = document.createElement('span');
        detail.className = 'detail';
        detail.textContent = `— ${item.detail}`;
        li.append(detail);
      }
      return li;
    }),
  );

  element('hint').textContent = view.hint ?? '';
  element('footer').textContent = view.footer ?? '';

  // #tab-pdf is deliberately NOT written here either: it comes from the tab
  // rather than from the host state, and a host refresh must not blank it.

  // #feedback is deliberately NOT written here. It carries the result of an
  // action the user just took, and printing re-renders the whole view straight
  // afterwards to pick up a printer that may have gone. When that message
  // shared #hint, the re-render wiped it and a test print reported nothing at
  // all - the sort of coupling only a real click exposes.
}

/**
 * Write the print section.
 *
 * ALWAYS VISIBLE. Hiding the button when the tab holds no PDF left the popup
 * with nothing but "Imprimer un test", which reads as if printing a receipt
 * were not what this extension does. A greyed button that says why is the
 * honest version.
 *
 * Its own applier: it comes from the tab rather than from the host state, and
 * a host refresh must not blank it.
 */
export function applyActiveTabPdf(
  document: Document,
  pdf: ActiveTabPdf | null,
  canPrint: boolean,
  reason?: string,
): void {
  const section = document.getElementById('tab-pdf');
  const name = document.getElementById('tab-pdf-name');
  const button = document.getElementById('print-tab') as HTMLButtonElement | null;
  if (section === null || name === null || button === null) return;

  section.hidden = false;

  if (pdf !== null) {
    name.textContent = pdf.name;
    // No printer check: the printer is chosen in the preview, so the only
    // thing that can stop this button is the service being down.
    button.disabled = !canPrint;
    button.title = canPrint ? '' : 'Le service ne répond pas.';
    return;
  }

  button.disabled = true;
  // Worded without blaming the user: telling someone who just clicked the
  // toolbar icon to click the toolbar icon is worse than saying nothing.
  // Reloading the page is what re-establishes the grant.
  if (reason === 'no-permission') {
    name.textContent = 'Onglet illisible. Rechargez la page du PDF, puis réessayez.';
    button.title = 'Accès à cet onglet non accordé.';
    return;
  }
  name.textContent = 'Ouvrez le reçu PDF dans un onglet pour l’imprimer.';
  button.title = 'Cet onglet n’affiche pas de PDF.';
}

/** Write the update section. Its own applier, like the sections above it. */
export function applyUpdateView(document: Document, view: UpdateView): void {
  const summary = document.getElementById('update-summary');
  const detail = document.getElementById('update-detail');
  const download = document.getElementById('download-update') as HTMLButtonElement | null;
  if (summary === null || detail === null || download === null) return;

  summary.textContent = view.summary;
  detail.textContent = view.detail ?? '';
  download.disabled = !view.canDownload;
}

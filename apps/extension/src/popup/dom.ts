import type { ActiveTabPdf } from '../messaging/protocol.ts';
import type { DetectedRow } from './detected.ts';
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

  const printer = element('printer');
  printer.hidden = view.printerName === undefined;
  element('printer-name').textContent = view.printerName ?? '—';

  const printTest = element<HTMLButtonElement>('print-test');
  printTest.disabled = !view.canPrintTest;
  printTest.title = view.printTestReason ?? '';

  element('hint').textContent = view.hint ?? '';
  element('footer').textContent = view.footer ?? '';

  // #tab-pdf and #detected are deliberately NOT written here either: it is driven by session
  // storage rather than by the host state, and re-rendering the host state
  // must not blank the list.

  // #feedback is deliberately NOT written here. It carries the result of an
  // action the user just took, and printing re-renders the whole view straight
  // afterwards to pick up a printer that may have gone. When that message
  // shared #hint, the re-render wiped it and a test print reported nothing at
  // all - the sort of coupling only a real click exposes.
}

/**
 * Write the detected-receipt list.
 *
 * Separate from the host view because the two have different sources: this list
 * comes from session storage and survives a host state refresh.
 *
 * The buttons carry their download id as a data attribute and are handled by
 * one delegated listener - inline handlers are forbidden by the manifest V3
 * content security policy.
 */
export function applyDetectedRows(document: Document, rows: readonly DetectedRow[]): void {
  const section = document.getElementById('detected');
  const list = document.getElementById('detected-list');
  if (section === null || list === null) return;

  section.hidden = rows.length === 0;
  list.replaceChildren(
    ...rows.map((row) => {
      const li = document.createElement('li');
      li.dataset['printed'] = String(row.printed);

      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = row.label;

      const detail = document.createElement('div');
      detail.className = 'detail';
      detail.textContent = row.caution === undefined ? row.detail : `${row.detail} — ${row.caution}`;

      li.append(label, detail);

      const actions = document.createElement('div');
      actions.className = 'row-actions';

      if (!row.printed) {
        actions.append(
          button(document, 'Imprimer', 'print-detected', row.downloadId),
          button(document, 'Ignorer', 'dismiss-detected', row.downloadId),
        );
      } else {
        actions.append(button(document, 'Retirer', 'dismiss-detected', row.downloadId));
      }
      li.append(actions);
      return li;
    }),
  );
}

function button(
  document: Document,
  text: string,
  action: string,
  downloadId: number,
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  element.dataset['action'] = action;
  element.dataset['downloadId'] = String(downloadId);
  return element;
}

/**
 * Write the active-tab section.
 *
 * Its own applier, for the same reason as the detected list: it comes from the
 * tab rather than from the host state, and a host refresh must not blank it.
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

  // Shown for a missing grant too, but worded without blaming the user: the
  // grant may be missing for reasons they cannot act on, and telling someone
  // who just clicked the icon to click the icon is worse than saying nothing.
  // It points at the download route instead, which needs no tab access at all.
  const showPermissionHint = pdf === null && reason === 'no-permission';
  section.hidden = pdf === null && !showPermissionHint;
  if (section.hidden) return;

  if (showPermissionHint) {
    name.textContent =
      'Onglet illisible. Téléchargez le reçu : il sera détecté automatiquement.';
    button.disabled = true;
    button.title = 'Accès à cet onglet non accordé.';
    return;
  }

  name.textContent = pdf?.name ?? '—';
  button.disabled = !canPrint;
  button.title = canPrint ? '' : 'Configurez une imprimante pour pouvoir imprimer.';
}

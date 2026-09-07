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

  // #detected is deliberately NOT written here either: it is driven by session
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

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

  // #feedback is deliberately NOT written here. It carries the result of an
  // action the user just took, and printing re-renders the whole view straight
  // afterwards to pick up a printer that may have gone. When that message
  // shared #hint, the re-render wiped it and a test print reported nothing at
  // all - the sort of coupling only a real click exposes.
}

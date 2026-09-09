/**
 * Approval page.
 *
 * Shows the ticket decoded from the ESC/POS bytes that will actually be sent,
 * so what the user approves is the job itself rather than a second rendering of
 * the same layout - and unlike the system print dialog, nothing between here
 * and the paper rescales it.
 *
 * Holds an id and nothing else: the worker keeps the source and does both the
 * rendering and the printing.
 */
import type { ExtensionRequest, ExtensionResponse } from '../messaging/protocol.ts';
import { previewFacts, printerChoices, sanitiseSvg } from './view.ts';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`élément #${id} absent de l'aperçu`);
  return found as T;
}

async function ask(request: ExtensionRequest): Promise<ExtensionResponse> {
  const response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse | undefined;
  return response ?? { kind: 'ERROR', message: 'Le service ne répond pas.' };
}

const previewIdFromUrl = new URLSearchParams(location.search).get('id') ?? '';

function setStatus(message: string, state?: 'error'): void {
  const status = element('status');
  status.textContent = message;
  if (state === undefined) delete status.dataset['state'];
  else status.dataset['state'] = state;
}

function showTicket(svg: string): void {
  const host = element('ticket');
  // Parsed rather than assigned as innerHTML, then reduced to the shapes the
  // decoder emits: it arrives as a string and ends up in a live document.
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = parsed.documentElement;
  if (root.tagName.toLowerCase() !== 'svg') {
    setStatus('Aperçu illisible.', 'error');
    return;
  }
  host.replaceChildren(document.importNode(sanitiseSvg(root), true));
}

async function render(): Promise<void> {
  const response = await ask({ kind: 'RENDER_PREVIEW', id: previewIdFromUrl });

  if (response.kind !== 'PREVIEW') {
    setStatus(response.kind === 'ERROR' ? response.message : 'Aperçu indisponible.', 'error');
    element<HTMLButtonElement>('print').disabled = true;
    return;
  }

  const facts = previewFacts(response.rendered, response.label);
  element('title').textContent = facts.title;
  element('fact-ticket').textContent = facts.ticket;
  element('fact-confidence').textContent = facts.confidence;
  element('fact-bytes').textContent = facts.size;
  element('warnings').textContent = facts.warnings;
  showTicket(response.rendered.content);

  setStatus('Ce que vous voyez est exactement ce qui sera envoyé à l’imprimante.');
  element<HTMLButtonElement>('print').disabled = !facts.canPrint;
}

/**
 * Offer every printer the host can see, with the configured one preselected.
 *
 * The choice belongs to this job: it is sent with the print and never written
 * back to the settings.
 */
async function loadPrinters(): Promise<void> {
  const [printersResponse, configResponse] = await Promise.all([
    ask({ kind: 'LIST_PRINTERS' }),
    ask({ kind: 'GET_CONFIG' }),
  ]);
  if (printersResponse.kind !== 'PRINTERS') return;

  const choices = printerChoices(
    printersResponse.printers,
    configResponse.kind === 'CONFIG' ? configResponse.config.printer.name : undefined,
    printersResponse.adapter,
  );

  const select = element<HTMLSelectElement>('printer');
  select.replaceChildren(
    ...(choices.selected === '' ? [new Option('— choisir —', '')] : []),
    ...choices.options.map((option) => new Option(option.label, option.value)),
  );
  select.value = choices.selected;
  select.disabled = false;
  element('printer-note').textContent = choices.note;
}

async function print(): Promise<void> {
  const printButton = element<HTMLButtonElement>('print');
  printButton.disabled = true;
  element('feedback').textContent = 'Impression…';

  const printerName = element<HTMLSelectElement>('printer').value;

  if (printerName === '') {
    // Caught here rather than at the host: the choice is on this page, so the
    // answer belongs on this page too.
    element('feedback').textContent = 'Choisissez une imprimante.';
    printButton.disabled = false;
    return;
  }

  const response = await ask({ kind: 'PRINT_PREVIEW', id: previewIdFromUrl, printerName });

  if (response.kind === 'PRINTED_RECEIPT') {
    const { ticketNumber, duplicate } = response.data;
    element('feedback').textContent =
      duplicate === true
        ? `Ticket ${ticketNumber} déjà imprimé à l’instant, rien envoyé.`
        : `Ticket ${ticketNumber} imprimé.`;
    setStatus('Envoyé. Vous pouvez fermer cet onglet.');
    return;
  }

  element('feedback').textContent =
    response.kind === 'ERROR' ? response.message : 'Réponse inattendue.';
  // Left enabled on failure: the point of an approval page is being able to
  // try again after fixing the printer.
  printButton.disabled = false;
}

document.addEventListener('DOMContentLoaded', () => {
  if (previewIdFromUrl === '') {
    setStatus('Aucun aperçu à afficher.', 'error');
    return;
  }

  element('print').addEventListener('click', () => {
    void print();
  });
  element('cancel').addEventListener('click', () => {
    void ask({ kind: 'DISCARD_PREVIEW', id: previewIdFromUrl }).then(() => window.close());
  });

  void loadPrinters();
  void render();
});

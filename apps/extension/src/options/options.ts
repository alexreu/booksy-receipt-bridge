/**
 * Options page.
 *
 * Settings live in the native host, not in the extension (plan section 18), so
 * this page is a form over GET_CONFIG / SET_CONFIG. That way a reinstalled
 * extension does not lose the printer setup, and the CLI sees the same values.
 */
import type { BridgeConfig, Printer } from '@brb/shared';
import type { ExtensionRequest, ExtensionResponse } from '../messaging/protocol.ts';
import type { HostState } from '../messaging/state.ts';
import { buildPatch, formValuesOf, optionsView, type FormValues } from './view.ts';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`élément #${id} absent des paramètres`);
  return found as T;
}

async function ask(request: ExtensionRequest): Promise<ExtensionResponse> {
  const response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse | undefined;
  return response ?? { kind: 'ERROR', message: 'Le service ne répond pas.' };
}

function readForm(): FormValues {
  return {
    printerName: element<HTMLSelectElement>('printer').value,
    paperWidth: element<HTMLInputElement>('paper-width').valueAsNumber,
    printableWidth: element<HTMLInputElement>('printable-width').valueAsNumber,
    columns: element<HTMLInputElement>('columns').valueAsNumber,
    showPreview: element<HTMLInputElement>('show-preview').checked,
    autoPrint: element<HTMLInputElement>('auto-print').checked,
    confidenceThreshold: element<HTMLInputElement>('threshold').valueAsNumber,
  };
}

function writeForm(values: FormValues, printers: readonly Printer[]): void {
  const select = element<HTMLSelectElement>('printer');
  const options = [
    new Option('— aucune —', ''),
    ...printers.map((printer) => new Option(printer.name, printer.name)),
  ];
  // A configured printer that is not in the list still has to be shown, or
  // opening this page would silently clear it on the next save.
  if (values.printerName !== '' && !printers.some((p) => p.name === values.printerName)) {
    options.push(new Option(`${values.printerName} (absente)`, values.printerName));
  }
  select.replaceChildren(...options);
  select.value = values.printerName;

  element<HTMLInputElement>('paper-width').valueAsNumber = values.paperWidth;
  element<HTMLInputElement>('printable-width').valueAsNumber = values.printableWidth;
  element<HTMLInputElement>('columns').valueAsNumber = values.columns;
  element<HTMLInputElement>('show-preview').checked = values.showPreview;
  element<HTMLInputElement>('auto-print').checked = values.autoPrint;
  element<HTMLInputElement>('threshold').valueAsNumber = values.confidenceThreshold;
}

function applyView(view: ReturnType<typeof optionsView>): void {
  const status = element('status');
  status.textContent = view.status;
  status.dataset['state'] = view.state;

  element<HTMLFieldSetElement>('fields').disabled = !view.editable;
  element<HTMLFieldSetElement>('printing-fields').disabled = !view.editable;
  element<HTMLButtonElement>('save').disabled = !view.editable;

  element('printer-note').textContent = view.printerNote ?? '';
  element('auto-print-note').textContent = view.autoPrintNote ?? '';
  element<HTMLInputElement>('auto-print').disabled = !view.canAutoPrint;
}

function feedback(message: string): void {
  element('feedback').textContent = message;
}

async function load(): Promise<void> {
  feedback('');
  const stateResponse = await ask({ kind: 'GET_HOST_STATE' });
  const state: HostState =
    stateResponse.kind === 'HOST_STATE'
      ? stateResponse.state
      : {
          kind: 'unavailable',
          error: {
            code: 'NATIVE_HOST_NOT_FOUND',
            message: stateResponse.kind === 'ERROR' ? stateResponse.message : 'Réponse inattendue.',
          },
        };

  if (state.kind !== 'connected') {
    applyView(optionsView({ state }));
    return;
  }

  const [printersResponse, configResponse] = await Promise.all([
    ask({ kind: 'LIST_PRINTERS' }),
    ask({ kind: 'GET_CONFIG' }),
  ]);

  const printers = printersResponse.kind === 'PRINTERS' ? printersResponse.printers : [];
  const adapter = printersResponse.kind === 'PRINTERS' ? printersResponse.adapter : undefined;

  applyView(optionsView({ state, printers, ...(adapter === undefined ? {} : { adapter }) }));

  if (configResponse.kind === 'CONFIG') {
    writeForm(formValuesOf(configResponse.config), printers);
    if (configResponse.error !== undefined) feedback(configResponse.error);
  } else if (configResponse.kind === 'ERROR') {
    feedback(configResponse.message);
  }
}

async function save(): Promise<void> {
  const built = buildPatch(readForm());
  if (!built.ok) {
    feedback(built.message);
    return;
  }

  feedback('Enregistrement…');
  const response = await ask({ kind: 'SET_CONFIG', patch: built.patch });
  if (response.kind === 'CONFIG') {
    // Re-read from what the host stored rather than keep the typed values: the
    // host is the source of truth and may have normalised something.
    const config: BridgeConfig = response.config;
    writeForm(formValuesOf(config), []);
    await load();
    feedback('Paramètres enregistrés.');
    return;
  }
  feedback(response.kind === 'ERROR' ? response.message : 'Réponse inattendue.');
}

document.addEventListener('DOMContentLoaded', () => {
  element('form').addEventListener('submit', (event) => {
    event.preventDefault();
    void save();
  });
  element('reload').addEventListener('click', () => {
    void load();
  });
  void load();
});

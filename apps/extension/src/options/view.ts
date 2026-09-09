import type { BridgeConfig, ConfigPatch, Printer } from '@brb/shared';
import type { HostState } from '../messaging/state.ts';
import { describeHostState } from '../messaging/state.ts';
import { PRETEND_ADAPTERS } from '../preview/view.ts';

/**
 * What the options page should show, and what a form submission means.
 *
 * Pure, so the page's behaviour is testable without a DOM - the same split as
 * the popup. `main`-side code only assigns these values and reads the form.
 */

export interface OptionsView {
  status: string;
  state: HostState['kind'];
  /** The fields are only usable once the host answered. */
  editable: boolean;
  printers: Printer[];
  /** Explains a printer list that is empty or comes from a mock. */
  printerNote?: string;
}

export interface OptionsInput {
  state: HostState;
  printers?: Printer[];
  adapter?: string;
}

export function optionsView(input: OptionsInput): OptionsView {
  const printers = input.printers ?? [];
  const connected = input.state.kind === 'connected';

  return {
    status: describeHostState(input.state),
    state: input.state.kind,
    editable: connected,
    printers,
    ...printerNote(connected, printers, input.adapter),
  };
}

function printerNote(
  connected: boolean,
  printers: readonly Printer[],
  adapter: string | undefined,
): { printerNote?: string } {
  if (!connected) return {};
  if (printers.length === 0) {
    return { printerNote: 'Aucune imprimante détectée sur ce poste.' };
  }
  if (adapter !== undefined && PRETEND_ADAPTERS.includes(adapter)) {
    return {
      printerNote: `Liste fournie par le pilote « ${adapter} » : ce ne sont pas de vraies imprimantes.`,
    };
  }
  return {};
}

export interface FormValues {
  printerName: string;
  paperWidth: number;
  printableWidth: number;
  columns: number;
}

export function formValuesOf(config: BridgeConfig): FormValues {
  return {
    printerName: config.printer.name,
    paperWidth: config.printer.paperWidth,
    printableWidth: config.printer.printableWidth,
    columns: config.printer.columns,
  };
}

/**
 * Build the patch to send, and refuse values that cannot be right.
 *
 * The host validates again - it must - but catching this here lets the page say
 * which field is wrong instead of surfacing a schema error.
 */
export function buildPatch(
  values: FormValues,
): { ok: true; patch: ConfigPatch } | { ok: false; message: string } {
  if (!Number.isFinite(values.paperWidth) || values.paperWidth <= 0) {
    return { ok: false, message: 'La largeur papier doit être un nombre positif.' };
  }
  if (!Number.isFinite(values.printableWidth) || values.printableWidth <= 0) {
    return { ok: false, message: 'La largeur imprimable doit être un nombre positif.' };
  }
  if (values.printableWidth > values.paperWidth) {
    return {
      ok: false,
      message: 'La largeur imprimable ne peut pas dépasser la largeur du papier.',
    };
  }
  if (!Number.isInteger(values.columns) || values.columns <= 0) {
    return { ok: false, message: 'Le nombre de colonnes doit être un entier positif.' };
  }
  return {
    ok: true,
    patch: {
      printer: {
        name: values.printerName,
        paperWidth: values.paperWidth,
        printableWidth: values.printableWidth,
        columns: values.columns,
      },
    },
  };
}

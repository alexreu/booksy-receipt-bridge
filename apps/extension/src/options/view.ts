import type { BridgeConfig, ConfigPatch, Printer } from '@brb/shared';
import type { HostState } from '../messaging/state.ts';
import { describeHostState } from '../messaging/state.ts';

/**
 * What the options page should show, and what a form submission means.
 *
 * Pure, so the page's behaviour is testable without a DOM - the same split as
 * the popup. `main`-side code only assigns these values and reads the form.
 */

/**
 * Whether the extension can act on the auto-print setting.
 *
 * The missing piece is in the EXTENSION, not the host: automatic printing needs
 * download detection (phase 7) and the trigger itself (phase 10). Gating this
 * on the host's message list was wrong - the host can print a receipt today,
 * but nothing asks it to automatically, so the checkbox would have been a
 * promise the extension cannot keep. Flip this when phase 10 lands.
 */
export const AUTO_PRINT_IMPLEMENTED = false;

export interface OptionsView {
  status: string;
  state: HostState['kind'];
  /** The fields are only usable once the host answered. */
  editable: boolean;
  printers: Printer[];
  /** Explains a printer list that is empty or comes from a mock. */
  printerNote?: string;
  /** Auto-print has no implementation yet; the checkbox says so. */
  autoPrintNote?: string;
  canAutoPrint: boolean;
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
    canAutoPrint: AUTO_PRINT_IMPLEMENTED && connected && printers.length > 0,
    ...(AUTO_PRINT_IMPLEMENTED
      ? {}
      : {
          autoPrintNote:
            'L’impression automatique n’est pas encore disponible : ' +
            'la détection des téléchargements arrive dans une version ultérieure.',
        }),
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
  if (adapter !== undefined && adapter !== 'windows') {
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
  showPreview: boolean;
  autoPrint: boolean;
  confidenceThreshold: number;
}

export function formValuesOf(config: BridgeConfig): FormValues {
  return {
    printerName: config.printer.name,
    paperWidth: config.printer.paperWidth,
    printableWidth: config.printer.printableWidth,
    columns: config.printer.columns,
    showPreview: config.printing.showPreview,
    autoPrint: config.printing.autoPrint,
    confidenceThreshold: config.printing.confidenceThreshold,
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
  if (
    !Number.isFinite(values.confidenceThreshold) ||
    values.confidenceThreshold < 0 ||
    values.confidenceThreshold > 1
  ) {
    return { ok: false, message: 'Le seuil de confiance doit être compris entre 0 et 1.' };
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
      printing: {
        showPreview: values.showPreview,
        autoPrint: values.autoPrint,
        confidenceThreshold: values.confidenceThreshold,
      },
    },
  };
}

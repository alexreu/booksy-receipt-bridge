import { describeHostState, hostChecklist, type HostState } from '../messaging/state.ts';

/**
 * What the popup should show for a given state.
 *
 * Pure: it takes a HostState and returns strings and flags, so the whole of the
 * popup's behaviour is testable without a DOM. The DOM code in main.ts only
 * assigns these values.
 */
export interface PopupView {
  summary: string;
  state: HostState['kind'];
  checklist: ReturnType<typeof hostChecklist>;
  printerName?: string;
  /** Enabled only when the host says it implements PRINT_TEST. */
  canPrintTest: boolean;
  printTestReason?: string;
  hint?: string;
  footer?: string;
}

export function popupView(state: HostState): PopupView {
  const base: PopupView = {
    summary: describeHostState(state),
    state: state.kind,
    checklist: hostChecklist(state),
    canPrintTest: false,
  };

  if (state.kind === 'unavailable') {
    return {
      ...base,
      printTestReason: 'Le service ne répond pas.',
      hint: hintFor(state.error.code),
      ...(state.error.detail === undefined ? {} : { footer: state.error.detail }),
    };
  }

  if (state.kind === 'version-mismatch') {
    return {
      ...base,
      printTestReason: 'Version du service incompatible.',
      hint: 'Mettez à jour Booksy Receipt Bridge sur ce poste.',
    };
  }

  if (state.kind === 'checking') return base;

  // Driven by what the host declares it supports, rather than by a hardcoded
  // list here: the button lights up on its own once printing lands, and it
  // cannot promise something the installed service cannot do.
  const supportsTest = state.status.supported.includes('PRINT_TEST');

  return {
    ...base,
    ...(state.status.printerConfigured
      ? {}
      : { hint: 'Choisissez une imprimante pour pouvoir imprimer.' }),
    canPrintTest: supportsTest && state.status.printerFound,
    ...(supportsTest
      ? state.status.printerFound
        ? {}
        : { printTestReason: 'Imprimante introuvable.' }
      : { printTestReason: 'Impression pas encore disponible dans le service installé.' }),
    ...(state.status.printerName === undefined ? {} : { printerName: state.status.printerName }),
    footer: `service ${state.version} · protocole ${state.status.protocolVersion} · pilote ${state.status.printerAdapter}`,
  };
}

function hintFor(code: string): string {
  switch (code) {
    case 'NATIVE_HOST_NOT_FOUND':
      return 'Installez Booksy Receipt Bridge sur ce poste, puis revérifiez.';
    case 'NATIVE_HOST_FORBIDDEN':
      return 'Le service doit être réenregistré avec l’identifiant de cette extension.';
    case 'NATIVE_HOST_CRASHED':
      return 'Consultez les journaux du service, puis revérifiez.';
    default:
      return 'Revérifiez, puis consultez les journaux du service.';
  }
}

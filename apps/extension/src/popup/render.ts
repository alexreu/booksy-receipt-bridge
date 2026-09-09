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
  hint?: string;
  footer?: string;
}

export function popupView(state: HostState): PopupView {
  const base: PopupView = {
    summary: describeHostState(state),
    state: state.kind,
    checklist: hostChecklist(state),
  };

  if (state.kind === 'unavailable') {
    return {
      ...base,
      hint: hintFor(state.error.code),
      ...(state.error.detail === undefined ? {} : { footer: state.error.detail }),
    };
  }

  if (state.kind === 'version-mismatch') {
    return {
      ...base,
      hint: 'Mettez à jour Booksy Receipt Bridge sur ce poste.',
    };
  }

  if (state.kind === 'checking') return base;

  return {
    ...base,
    // Not a blocker: the printer is chosen in the preview, per job. This only
    // says where.
    ...(state.status.printerConfigured
      ? {}
      : { hint: 'Aucune imprimante par défaut : choisissez-la dans l’aperçu.' }),
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

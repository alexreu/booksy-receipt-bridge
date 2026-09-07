import {
  PROTOCOL_VERSION,
  BRIDGE_ERROR_MESSAGES,
  type NativeError,
  type PingData,
  type StatusData,
} from '@brb/shared';
import { type NativeHostClient, nextMessageId } from './client.ts';

/**
 * What the extension knows about the host (plan section 16).
 *
 * A discriminated union rather than a bag of booleans, so the popup cannot
 * render a half-state - "connected but no version yet" is not representable.
 */
export type HostState =
  | { kind: 'checking' }
  | { kind: 'unavailable'; error: NativeError }
  | { kind: 'version-mismatch'; hostVersion: string; hostProtocol: number; expected: number }
  | { kind: 'connected'; version: string; status: StatusData };

/**
 * Ask the host where it stands.
 *
 * PING first, then GET_STATUS. The extra round trip is deliberate: PING is the
 * cheapest possible answer to "is anything there at all", and if the protocol
 * versions disagree there is no point interpreting a StatusData whose shape may
 * have changed.
 */
export async function resolveHostState(client: NativeHostClient): Promise<HostState> {
  const ping = await client.send<PingData>({ id: nextMessageId(), type: 'PING' });
  if (!ping.success || ping.data === undefined) {
    return { kind: 'unavailable', error: ping.error ?? unknownError() };
  }

  const hostProtocol = ping.data.protocolVersion;
  if (hostProtocol !== PROTOCOL_VERSION) {
    return {
      kind: 'version-mismatch',
      hostVersion: ping.data.version,
      hostProtocol,
      expected: PROTOCOL_VERSION,
    };
  }

  const status = await client.send<StatusData>({ id: nextMessageId(), type: 'GET_STATUS' });
  if (!status.success || status.data === undefined) {
    return { kind: 'unavailable', error: status.error ?? unknownError() };
  }

  return { kind: 'connected', version: ping.data.version, status: status.data };
}

/** One-line French summary of a state, for the popup and for logs. */
export function describeHostState(state: HostState): string {
  switch (state.kind) {
    case 'checking':
      return 'Vérification du service…';
    case 'unavailable':
      return state.error.message;
    case 'version-mismatch':
      return `Service en version ${state.hostVersion} (protocole ${state.hostProtocol}), l’extension attend le protocole ${state.expected}.`;
    case 'connected':
      return 'Service connecté';
  }
}

/**
 * The checklist the popup shows (plan section 16).
 *
 * Each item is independently true or false, so a host that answers but has no
 * printer configured reads as connected-but-incomplete rather than as broken.
 */
export interface HostChecklistItem {
  label: string;
  ok: boolean;
  detail?: string;
}

export function hostChecklist(state: HostState): HostChecklistItem[] {
  if (state.kind !== 'connected') {
    return [{ label: 'Service installé', ok: false, detail: describeHostState(state) }];
  }

  const { status } = state;
  return [
    { label: 'Service installé', ok: true, detail: `version ${status.version}` },
    {
      label: 'Configuration',
      ok: status.configPresent,
      detail: status.configPresent ? undefined : 'aucun fichier de configuration',
    },
    {
      label: 'Imprimante configurée',
      ok: status.printerConfigured,
      detail: status.printerConfigured ? undefined : 'aucune imprimante choisie',
    },
    {
      label: 'Imprimante détectée',
      ok: status.printerFound,
      // Says which implementation answered: until the Windows adapter exists,
      // a tick here would be a mock's word and the user should know that.
      detail: status.printerFound ? undefined : `pilote « ${status.printerAdapter} »`,
    },
  ];
}

function unknownError(): NativeError {
  return {
    code: 'INVALID_MESSAGE',
    message: BRIDGE_ERROR_MESSAGES.INVALID_MESSAGE,
    detail: 'Réponse vide du service.',
  };
}

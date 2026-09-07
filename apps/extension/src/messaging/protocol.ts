import type { HostState } from './state.ts';

/**
 * Messages passed inside the extension, popup or content script to the service
 * worker (plan section 9).
 *
 * The content script never speaks to the native host. It has the weakest trust
 * of any part of the extension - it runs in a page's world - so the worker is
 * the single place that decides what reaches the host.
 */
export type ExtensionRequest = { kind: 'GET_HOST_STATE' } | { kind: 'PING_HOST' };

export type ExtensionResponse =
  | { kind: 'HOST_STATE'; state: HostState }
  | { kind: 'ERROR'; message: string };

const KINDS: ExtensionRequest['kind'][] = ['GET_HOST_STATE', 'PING_HOST'];

/** Validate an inbound internal message; the worker trusts nothing by shape. */
export function parseExtensionRequest(raw: unknown): ExtensionRequest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const kind = (raw as Record<string, unknown>)['kind'];
  if (typeof kind !== 'string') return undefined;
  return KINDS.includes(kind as ExtensionRequest['kind'])
    ? ({ kind } as ExtensionRequest)
    : undefined;
}

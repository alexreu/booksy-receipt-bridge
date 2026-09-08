import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpdateCheck, UpdateDownload } from '@brb/shared';
import { isNewer } from './version.ts';

/**
 * Looking for a newer release on GitHub (plan section 50, extended).
 *
 * NEVER ON ITS OWN. This runs only when the user asks. AC19 says no data goes
 * to a remote server, and while a version check sends nothing about a receipt,
 * a service that phones home unprompted is not what that criterion has in
 * mind. There is no timer and no check at startup.
 *
 * THE HOST DOES THE NETWORK, NOT THE EXTENSION. The extension would need a
 * host permission for github.com and would put any token in the browser. Here
 * the token stays in a file only the user's account can read.
 *
 * A PRIVATE REPOSITORY NEEDS A TOKEN. Release assets on a private repo are not
 * publicly downloadable, so `update.token` must hold a read-only fine-grained
 * token. Public releases need none, and the same code path serves both.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface UpdateDeps {
  /** owner/name, e.g. "alexreu/booksy-receipt-bridge". */
  repo: string;
  currentVersion: string;
  /** Read-only token. Required for a private repository. */
  token?: string;
  /** Where a downloaded update is put. */
  downloadDir: string;
  fetch: FetchLike;
  log?: (message: string) => void;
}

/** Asset the installer is shipped as. */
const ASSET_PATTERN = /\.(?:zip|exe)$/i;

/**
 * How long to wait before giving up.
 *
 * Explicit, because undici's own connect timeout is ten seconds and the popup
 * sits on "Vérification…" for all of it with nothing to show. Observed here on
 * an intermittent connection: the request neither succeeded nor said anything
 * for eleven seconds. Better to fail quickly and let the user press again.
 */
export const REQUEST_TIMEOUT_MS = 8_000;

const USER_AGENT = 'booksy-receipt-bridge';

interface ReleaseAsset {
  name: string;
  url: string;
  browser_download_url: string;
  size: number;
}

interface Release {
  tag_name: string;
  name?: string | null;
  html_url: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  assets?: ReleaseAsset[];
}

function headers(token: string | undefined, accept: string): Record<string, string> {
  return {
    Accept: accept,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token === undefined || token === '' ? {} : { Authorization: `Bearer ${token}` }),
  };
}

/** Human-readable reason a check could not be made. */
function describeFailure(status: number, repo: string, hasToken: boolean): string {
  if (status === 404) {
    return hasToken
      ? `Dépôt ${repo} introuvable, ou le jeton n'y donne pas accès.`
      : `Dépôt ${repo} introuvable. S'il est privé, un jeton de lecture est nécessaire.`;
  }
  if (status === 401 || status === 403) {
    return hasToken
      ? 'Le jeton a été refusé par GitHub.'
      : 'Accès refusé par GitHub. Un jeton de lecture est nécessaire pour un dépôt privé.';
  }
  return `GitHub a répondu ${status}.`;
}

/** Unwrap the cause chain a failed fetch hides its reason in. */
export function describeNetworkError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as NodeJS.ErrnoException).code;
    parts.push(code === undefined ? current.message : `${current.message} [${code}]`);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.length === 0 ? String(error) : parts.join(' <- ');
}

/** Did the request give up on its own deadline? */
export function timedOut(error: unknown): boolean {
  const cause = shortCause(error);
  return (
    cause === 'UND_ERR_CONNECT_TIMEOUT' ||
    cause === 'UND_ERR_HEADERS_TIMEOUT' ||
    cause === 'TimeoutError' ||
    (error instanceof Error && error.name === 'TimeoutError')
  );
}

/** The shortest thing worth putting in front of a user. */
export function shortCause(error: unknown): string {
  let current: unknown = error;
  let code: string | undefined;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    code = (current as NodeJS.ErrnoException).code ?? code;
    current = (current as { cause?: unknown }).cause;
  }
  return code ?? (error instanceof Error ? error.message : String(error));
}

export async function checkForUpdate(deps: UpdateDeps): Promise<UpdateCheck> {
  const hasToken = deps.token !== undefined && deps.token !== '';
  const url = `https://api.github.com/repos/${deps.repo}/releases/latest`;

  let response: Response;
  try {
    response = await deps.fetch(url, {
      headers: headers(deps.token, 'application/vnd.github+json'),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // `fetch failed` on its own says nothing usable. The cause chain is where
    // the reason lives - ENOTFOUND, ECONNREFUSED, a certificate - and it is
    // the only thing that makes a network failure diagnosable from a log file.
    deps.log?.(`Vérification de mise à jour impossible : ${describeNetworkError(error)}`);
    return {
      current: deps.currentVersion,
      available: false,
      error: timedOut(error)
        ? 'GitHub n’a pas répondu à temps. Réessayez.'
        : `Réseau indisponible (${shortCause(error)}).`,
    };
  }

  if (!response.ok) {
    const error = describeFailure(response.status, deps.repo, hasToken);
    deps.log?.(`Vérification de mise à jour refusée : ${error}`);
    return { current: deps.currentVersion, available: false, error };
  }

  const release = (await response.json()) as Release;
  if (release.draft === true) {
    return { current: deps.currentVersion, available: false };
  }

  const latest = release.tag_name;
  const available = isNewer(latest, deps.currentVersion);
  const asset = (release.assets ?? []).find((candidate) => ASSET_PATTERN.test(candidate.name));

  deps.log?.(
    `Version publiée ${latest}, installée ${deps.currentVersion}` +
      (available ? ' — mise à jour disponible' : ' — à jour'),
  );

  return {
    current: deps.currentVersion,
    latest,
    available,
    releaseUrl: release.html_url,
    ...(release.prerelease === true ? { prerelease: true } : {}),
    ...(asset === undefined
      ? {}
      : { assetName: asset.name, assetBytes: asset.size }),
    ...(release.body === null || release.body === undefined || release.body === ''
      ? {}
      : { notes: release.body.slice(0, 2000) }),
  };
}

/** Refuse anything implausible for an installer, before writing it to disk. */
export const MAX_UPDATE_BYTES = 300 * 1024 * 1024;

export async function downloadUpdate(deps: UpdateDeps): Promise<UpdateDownload> {
  const check = await checkForUpdate(deps);
  if (check.error !== undefined) return { ok: false, error: check.error };
  if (!check.available || check.latest === undefined) {
    return { ok: false, error: 'Aucune mise à jour à télécharger.' };
  }

  const url = `https://api.github.com/repos/${deps.repo}/releases/latest`;
  const release = (await (
    await deps.fetch(url, { headers: headers(deps.token, 'application/vnd.github+json') })
  ).json()) as Release;

  const asset = (release.assets ?? []).find((candidate) => ASSET_PATTERN.test(candidate.name));
  if (asset === undefined) {
    return {
      ok: false,
      error: `La version ${check.latest} ne contient pas de fichier d'installation.`,
    };
  }

  // The API url with an octet-stream Accept, not browser_download_url: that is
  // the form that works for a private repository with a token, and it works
  // for a public one too.
  const download = await deps.fetch(asset.url, {
    headers: headers(deps.token, 'application/octet-stream'),
    // Generous: an installer is tens of megabytes, unlike a version check.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 15),
  });
  if (!download.ok) {
    return { ok: false, error: describeFailure(download.status, deps.repo, deps.token !== undefined) };
  }

  const bytes = new Uint8Array(await download.arrayBuffer());
  if (bytes.length > MAX_UPDATE_BYTES) {
    return { ok: false, error: `Fichier de ${bytes.length} octets, au-delà de la limite.` };
  }

  await mkdir(deps.downloadDir, { recursive: true });
  const path = join(deps.downloadDir, asset.name);
  await writeFile(path, bytes);
  deps.log?.(`Mise à jour ${check.latest} téléchargée (${bytes.length} octets)`);

  return { ok: true, path, bytes: bytes.length, version: check.latest };
}

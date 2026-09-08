import type { UpdateCheck, UpdateDownload } from '@brb/shared';

/**
 * How an update reads in the popup.
 *
 * Pure, like the rest of the popup's logic. The wording carries a distinction
 * that matters: "no update" and "could not tell" are different answers, and
 * conflating them would let a broken configuration look like being up to date.
 */
export interface UpdateView {
  /** The one line always shown once a check has been made. */
  summary: string;
  canDownload: boolean;
  /** Shown under the summary: release notes, or how to fix a failed check. */
  detail?: string;
}

export function updateView(check: UpdateCheck): UpdateView {
  if (check.error !== undefined) {
    return {
      // Not "up to date": the check did not happen, and saying otherwise would
      // hide a misconfigured token behind reassuring words.
      summary: 'Vérification impossible.',
      canDownload: false,
      detail: check.error,
    };
  }

  if (!check.available || check.latest === undefined) {
    return { summary: `À jour (version ${check.current}).`, canDownload: false };
  }

  const prerelease = check.prerelease === true ? ' (pré-version)' : '';
  return {
    summary: `Version ${check.latest} disponible${prerelease}, installée ${check.current}.`,
    canDownload: check.assetName !== undefined,
    ...detailOf(check),
  };
}

function detailOf(check: UpdateCheck): { detail?: string } {
  if (check.assetName === undefined) {
    return { detail: 'Cette version ne contient pas de fichier d’installation.' };
  }
  const notes = check.notes?.split('\n')[0]?.trim();
  return notes === undefined || notes === '' ? {} : { detail: notes };
}

export function downloadedView(download: UpdateDownload): string {
  if (!download.ok) return download.error;
  return `Version ${download.version} téléchargée. Lancez Install.ps1 depuis : ${download.path}`;
}

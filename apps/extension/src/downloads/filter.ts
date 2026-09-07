/**
 * Which downloads are worth showing to the native host (plan sections 19, 20).
 *
 * WHY NOT FILTER ON THE FILENAME. Section 20 suggests `ticket-*.pdf`, but the
 * real receipt this project was built against downloads as `recu-1167.pdf`, so
 * that pattern would have missed every one of them. The filename is treated as
 * a hint, never a gate.
 *
 * WHY NOT INSPECT EVERY PDF EITHER. Handing the parser every PDF the user
 * downloads - bank statements, contracts - is more access than this feature
 * needs, even though the host is local and nothing leaves the machine.
 *
 * So the gate is provenance: a completed .pdf that came from Booksy. A
 * receipt-shaped filename is accepted as well, which covers a file re-saved or
 * moved outside the browser flow. Either way it is only a candidate - the host
 * opens it and decides (plan section 21), because nothing about a download's
 * metadata proves what is inside it.
 */

/** Hosts a Booksy receipt can legitimately come from. */
export const BOOKSY_HOSTS = ['booksy.com', 'booksy.net'] as const;

/**
 * Receipt-shaped names, across the wordings Booksy uses.
 * Anchored at the start so `not-a-recu-1.pdf` does not match.
 */
const RECEIPT_NAME = /^(?:ticket|re[çc]u|receipt|rachunek|paragon)[-_ ]?\d/i;

export interface DownloadCandidate {
  id: number;
  /** Absolute local path, empty until the download completes. */
  filename: string;
  url?: string | undefined;
  referrer?: string | undefined;
  state?: string | undefined;
  /** Chrome sets this when the file was removed or never arrived. */
  exists?: boolean | undefined;
  mime?: string | undefined;
}

export function isBooksyHost(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Suffix match on a dot, so `booksy.com.evil.example` does not pass.
  return BOOKSY_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function basenameOf(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? '';
}

export function looksLikeReceiptName(path: string): boolean {
  return RECEIPT_NAME.test(basenameOf(path));
}

export function isPdf(candidate: DownloadCandidate): boolean {
  if (candidate.filename.toLowerCase().endsWith('.pdf')) return true;
  // A PDF served without a .pdf name is still worth a look; the extension check
  // is the cheap one, the mime type is the fallback.
  return candidate.mime === 'application/pdf';
}

/** Has the download finished and left a file behind? */
export function isComplete(candidate: DownloadCandidate): boolean {
  return (
    candidate.state === 'complete' &&
    candidate.filename !== '' &&
    candidate.exists !== false &&
    // Chrome writes to a .crdownload file first; a complete download never
    // still carries that suffix, and acting on one would read a partial PDF.
    !candidate.filename.toLowerCase().endsWith('.crdownload')
  );
}

export function isCandidate(candidate: DownloadCandidate): boolean {
  if (!isComplete(candidate)) return false;
  if (!isPdf(candidate)) return false;
  return (
    isBooksyHost(candidate.url) ||
    isBooksyHost(candidate.referrer) ||
    looksLikeReceiptName(candidate.filename)
  );
}

/** Why a candidate was picked up, for the log and for the popup's wording. */
export function candidateReason(candidate: DownloadCandidate): 'booksy' | 'filename' {
  return isBooksyHost(candidate.url) || isBooksyHost(candidate.referrer)
    ? 'booksy'
    : 'filename';
}

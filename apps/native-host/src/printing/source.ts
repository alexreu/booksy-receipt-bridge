import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, normalize, sep } from 'node:path';

/**
 * Turn a ReceiptSource into bytes, safely (plan sections 22 and 23).
 *
 * The path route exists so a downloaded PDF never crosses the messaging
 * channel - the host opens the file itself. That means the host is being handed
 * a filesystem path by the browser, so it decides what it is willing to open.
 * A content script must not be able to name an arbitrary file and have it read
 * back, so the rules are: a .pdf extension, inside an allowed directory, a
 * regular file, and small enough to be a receipt.
 *
 * Containment is checked AFTER resolving symlinks. A symlink in Downloads
 * pointing at ~/.ssh/id_rsa passes every textual check and is exactly the
 * attack this ordering prevents.
 */

/** A receipt PDF is tens of kilobytes; this is a generous ceiling. */
export const MAX_RECEIPT_BYTES = 20 * 1024 * 1024;

export type SourceResult =
  | { ok: true; bytes: Uint8Array; sha256: string; origin: string }
  | { ok: false; code: 'FILE_NOT_ALLOWED' | 'INVALID_RECEIPT'; message: string };

export interface ResolveSourceOptions {
  /** Directories a path may live in, on top of the Downloads folder. */
  allowedDirs?: readonly string[];
  /** Overridable for tests. */
  downloadsDir?: string;
}

export function defaultDownloadsDir(): string {
  return join(homedir(), 'Downloads');
}

export async function resolveSource(
  source: { kind: 'path'; path: string } | { kind: 'bytes'; base64: string },
  options: ResolveSourceOptions = {},
): Promise<SourceResult> {
  if (source.kind === 'bytes') return fromBase64(source.base64);
  return fromPath(source.path, options);
}

function fromBase64(base64: string): SourceResult {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return { ok: false, code: 'INVALID_RECEIPT', message: 'Contenu base64 illisible.' };
  }
  if (bytes.length === 0) {
    return { ok: false, code: 'INVALID_RECEIPT', message: 'Contenu vide.' };
  }
  if (bytes.length > MAX_RECEIPT_BYTES) {
    return { ok: false, code: 'INVALID_RECEIPT', message: tooBig(bytes.length) };
  }
  if (!looksLikePdf(bytes)) {
    return { ok: false, code: 'INVALID_RECEIPT', message: 'Ce contenu n’est pas un PDF.' };
  }
  return { ok: true, bytes: new Uint8Array(bytes), sha256: hash(bytes), origin: '(octets)' };
}

async function fromPath(path: string, options: ResolveSourceOptions): Promise<SourceResult> {
  if (!isAbsolute(path)) {
    return { ok: false, code: 'FILE_NOT_ALLOWED', message: 'Le chemin doit être absolu.' };
  }
  if (extname(path).toLowerCase() !== '.pdf') {
    return { ok: false, code: 'FILE_NOT_ALLOWED', message: 'Seuls les fichiers .pdf sont acceptés.' };
  }

  const roots = [options.downloadsDir ?? defaultDownloadsDir(), ...(options.allowedDirs ?? [])]
    .filter((root) => root !== '');

  let resolved: string;
  let resolvedRoots: string[];
  try {
    resolved = await realpath(path);
    // Roots are resolved too, so that a symlinked Downloads folder still
    // matches instead of failing the comparison.
    resolvedRoots = await Promise.all(
      roots.map((root) => realpath(root).catch(() => root)),
    );
  } catch {
    return { ok: false, code: 'FILE_NOT_ALLOWED', message: 'Fichier introuvable.' };
  }

  if (!resolvedRoots.some((root) => isInside(resolved, root))) {
    return {
      ok: false,
      code: 'FILE_NOT_ALLOWED',
      message: 'Ce fichier est hors des dossiers autorisés.',
    };
  }

  const info = await stat(resolved).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    return { ok: false, code: 'FILE_NOT_ALLOWED', message: 'Ce chemin n’est pas un fichier.' };
  }
  if (info.size > MAX_RECEIPT_BYTES) {
    return { ok: false, code: 'INVALID_RECEIPT', message: tooBig(info.size) };
  }

  const bytes = await readFile(resolved);
  if (!looksLikePdf(bytes)) {
    return { ok: false, code: 'INVALID_RECEIPT', message: 'Ce fichier n’est pas un PDF.' };
  }
  return { ok: true, bytes: new Uint8Array(bytes), sha256: hash(bytes), origin: resolved };
}

/**
 * Is `candidate` the root itself or below it?
 *
 * The separator matters: without it "/Users/x/Downloads-secret" would pass as
 * being inside "/Users/x/Downloads". Windows paths are compared
 * case-insensitively, as the filesystem is.
 *
 * Both sides are normalised first, which on Windows turns a forward slash into
 * a backslash. An allowed directory is typed by a person into a configuration
 * file, and "C:/Users/x/Downloads" is a perfectly reasonable thing to type -
 * without this it matched nothing, because the comparison was made against a
 * path the filesystem had written with backslashes.
 */
export function isInside(candidate: string, root: string): boolean {
  const normalise = (value: string): string => {
    const normalised = normalize(value);
    const trimmed = normalised.endsWith(sep) ? normalised.slice(0, -sep.length) : normalised;
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  const target = normalise(candidate);
  const base = normalise(root);
  return target === base || target.startsWith(`${base}${sep}`);
}

/**
 * A PDF starts with %PDF-, though some writers emit junk first, which readers
 * tolerate. Checking the first kilobyte matches that tolerance without
 * accepting a file that merely happens to contain the marker somewhere.
 */
function looksLikePdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 1024).includes(Buffer.from('%PDF-', 'latin1'));
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function tooBig(size: number): string {
  return `Fichier de ${size} octets, au-delà de la limite de ${MAX_RECEIPT_BYTES}.`;
}

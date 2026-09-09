import type { ActiveTabPdf } from '../messaging/protocol.ts';

/**
 * Recognise a tab that is showing a PDF.
 *
 * This is the receipt's real entry point: Booksy opens the receipt as a PDF in
 * a tab, and the button offered for it is in the popup rather than injected
 * into the page. That keeps the extension out of any site's DOM entirely - no
 * content script, no host permissions, and nothing to re-guess when a site is
 * redesigned.
 *
 * Two signals, because neither alone is enough. A URL path ending in .pdf is
 * the obvious one, but a PDF can be served from a URL that says nothing; the
 * built-in viewer sets the tab title to the filename, which usually does.
 *
 * `file:` counts, and takes a different route to the bytes. The worker cannot
 * read a local file - that needs a permission this extension deliberately does
 * not ask for - but the SERVICE can, and already does it safely: it re-validates
 * the path against its allowed directories, resolves symlinks first, and checks
 * the file really is a PDF (plan section 23). So a file:// tab is printed by
 * handing the service the path, never by reading the file in the browser.
 */

export interface TabInfo {
  url?: string | undefined;
  title?: string | undefined;
}

/** Schemes a receipt can be printed from. */
const PRINTABLE = ['http:', 'https:', 'file:'];

function endsWithPdf(value: string): boolean {
  return value.toLowerCase().endsWith('.pdf');
}

export function basenameOfUrl(url: URL): string {
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const last = segments[segments.length - 1];
  if (last === undefined || last === '') return url.hostname;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * Why no printable PDF was found.
 *
 * `no-permission` is worth distinguishing. `activeTab` is granted only when the
 * user actually invokes the extension - clicking the toolbar icon - and until
 * then `chrome.tabs.query` returns a tab with no url at all. Observed while
 * testing: the query came back as `[{}]`. Without this distinction the popup
 * would say "this tab is not a PDF" about a tab that plainly is.
 */
export type NoPdfReason = 'no-permission' | 'not-a-pdf' | 'no-tab';

export interface ActiveTabResult {
  pdf: ActiveTabPdf | null;
  reason?: NoPdfReason;
}

export function activeTabResultOf(tab: TabInfo | undefined): ActiveTabResult {
  if (tab === undefined) return { pdf: null, reason: 'no-tab' };
  // A tab object with no url means the host permission for it was never
  // granted; an empty title alone would not be conclusive.
  if (tab.url === undefined || tab.url === '') return { pdf: null, reason: 'no-permission' };

  const pdf = activeTabPdfOf(tab);
  return pdf === null ? { pdf: null, reason: 'not-a-pdf' } : { pdf };
}

export function activeTabPdfOf(tab: TabInfo | undefined): ActiveTabPdf | null {
  if (tab?.url === undefined || tab.url === '') return null;

  let url: URL;
  try {
    url = new URL(tab.url);
  } catch {
    return null;
  }

  // blob:, data: and chrome-extension: are out: there is nothing there the
  // service could be handed, and nothing worth printing.
  if (!PRINTABLE.includes(url.protocol)) return null;
  // A UNC path (file://serveur/partage) is not this machine's filesystem, and
  // the service would refuse it anyway.
  if (url.protocol === 'file:' && url.hostname !== '') return null;

  const byPath = endsWithPdf(url.pathname);
  const byTitle = tab.title !== undefined && endsWithPdf(tab.title.trim());
  if (!byPath && !byTitle) return null;

  const name = byTitle && tab.title !== undefined ? tab.title.trim() : basenameOfUrl(url);
  return { name, url: tab.url };
}

/**
 * The local path behind a `file:` URL.
 *
 * Returned so the SERVICE can open the file: it is the only side allowed to,
 * and it validates the path again before it does. Undefined for anything that
 * is not a plain local file URL.
 */
export function localPathOf(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'file:' || url.hostname !== '') return undefined;

  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  // Windows: file:///C:/... gives /C:/..., which is not a path Node accepts.
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
}

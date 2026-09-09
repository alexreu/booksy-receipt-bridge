/**
 * The slice of `chrome.storage` the worker needs, so tests need no browser.
 *
 * Session storage rather than local wherever this is used: what it holds is
 * about the last few minutes - a receipt waiting to be approved - and has no
 * business outliving the browser.
 */
export interface SessionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

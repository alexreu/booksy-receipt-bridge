/**
 * Service worker.
 *
 * Phase 0 stub. It exists so the MV3 build has a real entry point and so the
 * extension loads without error; it holds no native messaging yet (phase 5), no
 * download detection (phase 7) and no printing.
 *
 * Design constraint recorded here because it shapes every later phase: an MV3
 * service worker is evicted after about 30 seconds idle, so this worker must
 * never become the home of long-lived state. Configuration lives in the native
 * host (plan section 18), and native calls are one-shot.
 */

const NATIVE_HOST_NAME = 'com.alexdevlab.booksy_receipt_bridge';

chrome.runtime.onInstalled.addListener((details) => {
  console.info('[brb] installed', details.reason, 'host:', NATIVE_HOST_NAME);
});

export {};

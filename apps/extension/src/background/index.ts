/**
 * Service worker.
 *
 * The only part of the extension that talks to the native host (plan section 9):
 *
 *   Booksy DOM -> content script -> chrome.runtime.sendMessage
 *              -> this worker    -> chrome.runtime.sendNativeMessage -> host
 *
 * It holds no state. An MV3 worker is evicted after about 30 seconds idle, so
 * anything it remembered would vanish unpredictably; the configuration lives in
 * the host (plan section 18) and every native call is one-shot.
 */
import { ChromeNativeHostClient } from '../messaging/client.ts';
import { handleExtensionMessage } from './router.ts';

const client = new ChromeNativeHostClient((application, message) =>
  chrome.runtime.sendNativeMessage(application, message),
);

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  handleExtensionMessage(raw, { id: sender.id }, {
    client,
    extensionId: chrome.runtime.id,
    log: (message) => console.warn('[brb]', message),
  })
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({
        kind: 'ERROR',
        message: error instanceof Error ? error.message : String(error),
      });
    });

  // Keep the message channel open for the async reply.
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  console.info('[brb] installé', details.reason, '| id', chrome.runtime.id);
});

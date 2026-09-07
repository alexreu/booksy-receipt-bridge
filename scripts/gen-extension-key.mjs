#!/usr/bin/env node
/**
 * Generate the key that pins the extension ID.
 *
 * An unpacked extension gets a new ID every time it is reloaded unless the
 * manifest carries a `key`. Since the native host manifest lists exact origins
 * (`chrome-extension://<id>/`) and wildcards are forbidden, an unstable ID means
 * re-editing the host manifest constantly. Doing this in phase 0 avoids that.
 *
 *   node scripts/gen-extension-key.mjs
 *
 * Writes apps/extension/key.pem (gitignored - keep it in a password manager;
 * it is only needed to sign a .crx yourself) and prints the public key to paste
 * into manifest.json plus the extension ID it produces.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const PEM_PATH = 'apps/extension/key.pem';

if (existsSync(PEM_PATH) && !process.argv.includes('--force')) {
  console.error(`${PEM_PATH} already exists. Pass --force to replace it.`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

writeFileSync(PEM_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

const spki = publicKey.export({ type: 'spki', format: 'der' });

/** Chrome derives the ID from the first 16 bytes of sha256(DER), base-16 to a-p. */
function extensionId(der) {
  const digest = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...digest].map((char) => String.fromCharCode(97 + parseInt(char, 16))).join('');
}

console.log(`wrote ${PEM_PATH} (do not commit)`);
console.log('\nmanifest.json "key":');
console.log(spki.toString('base64'));
console.log('\nextension id:');
console.log(extensionId(spki));

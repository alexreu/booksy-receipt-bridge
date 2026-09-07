import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Copies the hand-written manifest next to the bundle.
 *
 * The manifest is authored by hand rather than generated: it is the security
 * surface of the extension (permissions, host permissions, the pinned key), and
 * it should be reviewable as a plain diff.
 */
function copyManifest(): Plugin {
  return {
    name: 'brb-copy-manifest',
    apply: 'build',
    async closeBundle() {
      await copyFile(
        resolve(import.meta.dirname, 'manifest.json'),
        resolve(import.meta.dirname, 'dist/manifest.json'),
      );
    },
  };
}

export default defineConfig({
  root: 'src',
  // Relative asset URLs: an extension page can be opened from several paths and
  // must not depend on being served from the package root.
  base: './',
  plugins: [copyManifest()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // No remote code, no eval: manifest V3 CSP forbids both (plan section 43).
    target: 'chrome116',
    modulePreload: false,
    rollupOptions: {
      input: {
        'background/index': resolve(import.meta.dirname, 'src/background/index.ts'),
        'popup/index': resolve(import.meta.dirname, 'src/popup/index.html'),
        'options/index': resolve(import.meta.dirname, 'src/options/index.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'debug/**',
      'fixtures/**',
      'installer/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Everything in this repo runs on Node except the extension sources, which
    // get browser globals below.
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The native host must never write to stdout: stdout is the Native Messaging
    // channel. Logs go to stderr or to a file (plan section 63).
    files: ['apps/native-host/src/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: ['apps/extension/src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, chrome: 'readonly' },
    },
  },
);

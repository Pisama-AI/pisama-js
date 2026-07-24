// Flat ESLint config for the TS SDK packages (sdk, detectors, cli).
// Non-type-checked recommended preset: a real lint gate without per-package
// `parserOptions.project` wiring. `eslint-config-prettier` is applied last so
// stylistic rules never fight Prettier (Prettier owns formatting).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      complexity: ['error', 15],
    },
  },
  prettier,
);

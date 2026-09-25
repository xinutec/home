// @ts-check
const eslint = require('@eslint/js');
const { defineConfig } = require('eslint/config');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');

module.exports = defineConfig([
  {
    files: ['src/**/*.ts'],
    extends: [
      eslint.configs.recommended,
      // Type-aware: without it no-base-to-string and friends, which stop an
      // `[object Object]` reaching the screen, load but never fire.
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      angular.configs.tsRecommended,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: __dirname },
    },
    processor: angular.processInlineTemplates,
    rules: {
      // `x as Shape` is a claim, not a check, and the type-aware rules trust it.
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'app',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'app',
          style: 'kebab-case',
        },
      ],
    },
  },
  {
    // Specs reach protected members as `app['showIds']()`; dot notation would
    // not compile.
    files: ['src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/dot-notation': ['error', { allowProtectedClassPropertyAccess: true }],
    },
  },
  {
    // Test doubles are asserted into the type they stand in for.
    files: ['src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
    },
  },
  {
    // The layout harness. Type-aware for no-floating-promises: an unawaited
    // `route.fulfill(...)` still passes the test.
    //
    // `ng lint` reads the files named by angular.json's lintFilePatterns;
    // this list alone changes nothing.
    //
    // `project`, not `projectService`: the service would bind these files to
    // tsconfig.json, which is solution-style and covers nothing.
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: { project: ['tsconfig.e2e.json'], tsconfigRootDir: __dirname },
    },
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {
      // `x == null` checks null and undefined at once.
      '@angular-eslint/template/eqeqeq': ['error', { allowNullOrUndefined: true }],
    },
  },
]);

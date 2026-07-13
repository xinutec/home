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
      // Type-aware: without a project the rules that need types — notably
      // no-base-to-string / restrict-template-expressions, the ones that stop a
      // value rendering as `[object Object]` — load but never fire.
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      angular.configs.tsRecommended,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: __dirname },
    },
    processor: angular.processInlineTemplates,
    rules: {
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
    // A spec reaches a component's protected members the only way TypeScript
    // permits from outside the class — `app['showIds']()`. That is the testing
    // idiom, not a style slip: dot notation there is a compile error.
    files: ['src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/dot-notation': ['error', { allowProtectedClassPropertyAccess: true }],
    },
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {
      // Allow `x == null` / `x != null` as a deliberate null-or-undefined check;
      // strict equality is still required everywhere else.
      '@angular-eslint/template/eqeqeq': ['error', { allowNullOrUndefined: true }],
    },
  },
]);

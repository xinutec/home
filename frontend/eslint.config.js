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
      // `x as Shape` is a claim, not a check — and it is the one hole left in
      // the protection against a value reaching the screen in the wrong shape.
      // The type-aware rules above, and dev-lint's DL-ANGULAR-STRINGIFIED-OBJECT
      // over the templates, both reason from the declared types; the only way to
      // fool them is with a type we manufactured ourselves.
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
    // A spec reaches a component's protected members the only way TypeScript
    // permits from outside the class — `app['showIds']()`. That is the testing
    // idiom, not a style slip: dot notation there is a compile error.
    files: ['src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/dot-notation': ['error', { allowProtectedClassPropertyAccess: true }],
    },
  },
  {
    // A double asserted into the interface it stands in for is the whole point
    // of a double; getting it wrong fails a test, it never reaches a user. App
    // code stays strict.
    files: ['src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
    },
  },
  {
    // The layout harness and its specs. The blocks above say `src`, so until
    // this existed the e2e tree was linted by nothing, on top of being
    // type-checked by nothing (see tsconfig.e2e.json). It is the only gate that
    // can see what a phone actually suffers, which makes "nobody checks it" the
    // wrong property for it to have.
    //
    // Type-aware, and that is the point: the rule that pays here is
    // no-floating-promises. A `route.fulfill(...)` dropped inside a route
    // handler still mocks the request, so the test passes and nothing says the
    // handler returned before the fulfilment finished.
    //
    // ⚠ `ng lint` decides what it reads from angular.json's lintFilePatterns,
    // not from this file — widening one without the other changes nothing.
    //
    // ⚠ `project`, not `projectService`, and only here. The service finds a
    // file's project by walking up to the nearest tsconfig.json — and this
    // one is solution-style, `"files": []`, so it claims nothing and the specs
    // bind to no project at all. Naming tsconfig.e2e.json is the honest answer:
    // it is the config that actually covers these files.
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
      // Allow `x == null` / `x != null` as a deliberate null-or-undefined check;
      // strict equality is still required everywhere else.
      '@angular-eslint/template/eqeqeq': ['error', { allowNullOrUndefined: true }],
    },
  },
]);

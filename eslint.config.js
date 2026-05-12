import js from '@eslint/js';
import ts from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import security from 'eslint-plugin-security';
import globals from 'globals';

/**
 * ESLint configuration for bt-servant-telemetry monorepo.
 *
 * Fitness Functions (code quality metrics):
 * - max-lines-per-function: 50 (skip blanks/comments)
 * - max-statements: 25 per function
 * - complexity: 10 (cyclomatic)
 * - max-depth: 4 (nested blocks)
 * - max-nested-callbacks: 3
 * - max-params: 5
 *
 * Cloned from lasker-opening-service. Per-package overrides for monorepo
 * paths (apps/*, packages/*) plus an override for SvelteKit chart components
 * which are mostly declarative ECharts option objects.
 */

/** @type {import('eslint').Linter.Config[]} */
export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,
  security.configs.recommended,

  // Global settings
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // ===========================================
  // CODE QUALITY RULES (Fitness Functions)
  // ===========================================
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    rules: {
      'max-lines-per-function': [
        'error',
        {
          max: 50,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        },
      ],
      'max-statements': ['error', 25],
      complexity: ['error', 10],
      'max-depth': ['error', 4],
      'max-nested-callbacks': ['error', 3],
      'max-params': ['error', 5],

      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      'no-console': ['warn', { allow: ['warn', 'error'] }],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      '@typescript-eslint/no-empty-object-type': [
        'error',
        { allowInterfaces: 'with-single-extends' },
      ],
    },
  },

  // ===========================================
  // INGEST / TAIL / SCHEDULED: console.log allowed for observability
  // ===========================================
  {
    files: [
      'apps/*/src/services/**/*.ts',
      'apps/*/src/tail/**/*.ts',
      'apps/*/src/ingest/**/*.ts',
      'apps/*/src/scheduled/**/*.ts',
      'apps/*/src/scripts/**/*.ts',
    ],
    rules: {
      'no-console': ['warn', { allow: ['log', 'warn', 'error'] }],
    },
  },

  // ===========================================
  // TEST FILES: relaxed
  // ===========================================
  {
    files: ['**/tests/**/*.ts', '**/*.test.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-statements': 'off',
    },
  },

  // ===========================================
  // ONION ARCHITECTURE: types layer purity
  // ===========================================
  {
    files: ['**/types/**/*.ts', 'packages/shared/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../routes/*', '../services/*', '*/routes/*', '*/services/*'],
              message: 'Types and shared package should have no internal app dependencies',
            },
          ],
        },
      ],
    },
  },

  // ===========================================
  // IGNORES
  // ===========================================
  {
    ignores: [
      'dist/',
      'node_modules/',
      'coverage/',
      '**/dist/',
      '**/node_modules/',
      '**/.wrangler/',
      '**/.svelte-kit/',
      '**/*.config.js',
      '**/*.config.ts',
      '**/*.config.mjs',
    ],
  },
];

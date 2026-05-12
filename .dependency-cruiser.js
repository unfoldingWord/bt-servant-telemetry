/**
 * dependency-cruiser configuration for bt-servant-telemetry monorepo.
 *
 * Enforces:
 * - No circular dependencies (anywhere)
 * - Onion architecture per app (apps/web/src/<layer>/)
 * - shared package has no app dependencies
 *
 * Cloned from lasker-opening-service, paths adapted for monorepo layout.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependencies make code hard to reason about. Type-only imports (import type) are excluded since they are erased at compile time.',
      from: {},
      to: {
        circular: true,
        dependencyTypesNot: ['type-only'],
      },
    },

    // ===========================================
    // ONION ARCHITECTURE — apps/web
    // ===========================================

    // tail / scheduled / api / sveltekit cannot import from each other
    {
      name: 'tail-no-other-handlers',
      severity: 'error',
      comment: 'tail handler may only depend on ingest, zulip, config, shared',
      from: { path: '^apps/web/src/tail' },
      to: { path: '^apps/web/src/(scheduled|api|sveltekit)' },
    },
    {
      name: 'scheduled-no-other-handlers',
      severity: 'error',
      comment: 'scheduled handler may only depend on ingest, zulip, config, shared',
      from: { path: '^apps/web/src/scheduled' },
      to: { path: '^apps/web/src/(tail|api|sveltekit)' },
    },
    {
      name: 'api-no-other-handlers',
      severity: 'error',
      comment: 'api handler may only depend on ingest, zulip, config, shared',
      from: { path: '^apps/web/src/api' },
      to: { path: '^apps/web/src/(tail|scheduled|sveltekit)' },
    },
    {
      name: 'sveltekit-no-other-handlers',
      severity: 'error',
      comment: 'sveltekit may only depend on api (via fetch), config, shared',
      from: { path: '^apps/web/src/sveltekit' },
      to: { path: '^apps/web/src/(tail|scheduled|ingest|zulip)' },
    },

    // ingest / zulip cannot import from handler layers
    {
      name: 'ingest-no-handlers',
      severity: 'error',
      comment: 'ingest is a pure transformation layer — must not depend on handlers',
      from: { path: '^apps/web/src/ingest' },
      to: { path: '^apps/web/src/(tail|scheduled|api|sveltekit)' },
    },
    {
      name: 'zulip-no-handlers',
      severity: 'error',
      comment: 'zulip client must not depend on handlers',
      from: { path: '^apps/web/src/zulip' },
      to: { path: '^apps/web/src/(tail|scheduled|api|sveltekit)' },
    },

    // config cannot import business layers
    {
      name: 'config-no-business',
      severity: 'error',
      comment: 'Config must not depend on any business or handler layer',
      from: { path: '^apps/web/src/config' },
      to: { path: '^apps/web/src/(tail|scheduled|api|sveltekit|ingest|zulip)' },
    },

    // shared package has no dependencies on any app
    {
      name: 'shared-no-app-deps',
      severity: 'error',
      comment: 'packages/shared must have no dependencies on any app',
      from: { path: '^packages/shared' },
      to: { path: '^apps/' },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    exclude: {
      path: '(\\.test\\.ts$|/tests/|\\.svelte-kit/|\\.wrangler/)',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};

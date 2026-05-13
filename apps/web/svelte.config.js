import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * SvelteKit config for bt-servant-telemetry.
 *
 * Why adapter-static:
 *   The dashboard is public, read-only, no-auth, and pulls all data from
 *   /api/* on the same worker. SSR adds nothing; static SPA keeps the
 *   Worker composition simple — Hono owns /api and /health, the static
 *   ASSETS binding serves the dashboard. fallback: 'index.html' enables
 *   client-side routing without prerender entries.
 *
 * Source layout deviates from SvelteKit defaults so worker code
 * (tail/ingest/api/scheduled) can coexist with the dashboard under one
 * apps/web/src/ tree.
 */
/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html',
      precompress: false,
      strict: true,
    }),
    files: {
      assets: 'src/sveltekit/static',
      lib: 'src/sveltekit/lib',
      routes: 'src/sveltekit/routes',
      appTemplate: 'src/sveltekit/app.html',
      hooks: {
        client: 'src/sveltekit/hooks.client',
        server: 'src/sveltekit/hooks.server',
      },
    },
    outDir: '.svelte-kit',
  },
};

export default config;

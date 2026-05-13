import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    // In `pnpm dev:ui`, the Vite dev server proxies /api/* to `wrangler dev`
    // on port 8787 so the UI can be developed with HMR against the real
    // Hono API.
    proxy: {
      '/api': 'http://localhost:8787',
      '/health': 'http://localhost:8787',
    },
  },
});

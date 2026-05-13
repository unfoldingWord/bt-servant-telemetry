import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// wrangler.toml declares `[assets] directory = "./build"` so the deployed
// Worker can fall through unknown routes to the prerendered SPA. miniflare
// resolves that path at test setup and errors out if the directory does
// not exist — which it doesn't on a fresh CI checkout, where the SPA
// hasn't been built yet. Tests don't actually exercise the assets binding
// (the Env type leaves ASSETS optional); they only need the path to be a
// valid binding target. Ensuring the directory exists keeps tests
// independent of `pnpm run build` while honoring the wrangler.toml contract.
const buildDir = path.join(__dirname, 'build');
if (!existsSync(buildDir)) mkdirSync(buildDir, { recursive: true });

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(__dirname, 'migrations');
  const migrations = await readD1Migrations(migrationsPath);
  return {
    test: {
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            bindings: {
              ENVIRONMENT: 'test',
              TELEMETRY_EPOCH: '2026-04-24',
              PII_HASH_SALT: 'test-salt-deterministic',
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
      include: ['tests/**/*.test.ts'],
      testTimeout: 30000,
    },
  };
});

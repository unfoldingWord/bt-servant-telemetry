import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

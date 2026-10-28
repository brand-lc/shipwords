import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd; each test file gets its own in-memory D1, so parallel worktrees don't interfere.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'test/migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.test.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: { include: ['test/**/*.test.ts'], setupFiles: ['./test/apply-migrations.ts'] },
  };
});

#!/usr/bin/env node
// Usage: node ../../tools/dev-port.mjs vite dev
// Derives a stable port from the site directory's absolute path, sets PORT and runs the command.
// Several worktrees can pnpm dev at once without clashing; the same directory always gets the same port, matching APP_URL in .dev.vars.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function portFor(dir, base = 5200, span = 2000) {
  const hash = createHash('sha1').update(path.resolve(dir).toLowerCase()).digest();
  return base + (hash.readUInt16BE(0) % span);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv.length > 2
) {
  const port = process.env.PORT ?? String(portFor(process.cwd()));
  const [command, ...args] = process.argv.slice(2);
  console.log(`[dev-port] http://localhost:${port}`);
  const child = spawn([command, ...args, '--port', port].join(' '), {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, PORT: port },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

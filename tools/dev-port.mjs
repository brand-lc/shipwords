#!/usr/bin/env node
// Usage: node ../../tools/dev-port.mjs vite dev
// Derives a stable port for the site directory, sets PORT and runs the command.
// The main checkout hashes only the site name, so the port survives moving or re-cloning the repo (and matches on every machine);
// a git worktree hashes the full path, so several worktrees can pnpm dev at once without clashing. setup:worktree writes the same port to APP_URL.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A worktree's .git is a file pointing at the main repo; the main checkout's .git is a directory.
export function isWorktree(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const git = path.join(d, '.git');
    if (fs.existsSync(git)) return fs.statSync(git).isFile();
    if (path.dirname(d) === d) return false;
  }
}

export function portFor(dir, worktree = isWorktree(dir), base = 5200, span = 2000) {
  const key = worktree ? path.resolve(dir) : path.basename(path.resolve(dir));
  const hash = createHash('sha1').update(key.toLowerCase()).digest();
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

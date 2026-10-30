#!/usr/bin/env node
// Usage: node ../../tools/dev-port.mjs vite dev
// Each site has a fixed port in its package.json ("devPort", 10 apart; new-site assigns the next one). The main checkout
// uses it as is; a git worktree adds 1-9 from a hash of its path, so worktrees of one site rarely clash and the port
// still tells which site it is. setup:worktree writes the same port to APP_URL.
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

export function sitePort(dir) {
  const file = path.join(dir, 'package.json');
  const { devPort } = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Number.isInteger(devPort))
    throw new Error(`${file} has no devPort; use 10 above the highest one under sites/`);
  return devPort;
}

export function portFor(dir, worktree = isWorktree(dir), base = sitePort(dir)) {
  if (!worktree) return base;
  const hash = createHash('sha1').update(path.resolve(dir).toLowerCase()).digest();
  return base + 1 + (hash.readUInt16BE(0) % 9);
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

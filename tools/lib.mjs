// Small helpers shared by repo scripts. Node built-ins only, no install needed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The shipwords checkout these scripts live in (templates come from here). */
export const TOOLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The workspace being worked on (sites live here): nearest pnpm-workspace.yaml above cwd. Differs from TOOLS_ROOT when shipwords is vendored as a submodule. */
export const ROOT = findWorkspaceRoot(process.cwd()) ?? TOOLS_ROOT;

function findWorkspaceRoot(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'pnpm-workspace.yaml'))) return d;
    if (path.dirname(d) === d) return null;
  }
}
export const SECRETS_DIR = process.env.SHIPWORDS_SECRETS ?? path.join(os.homedir(), '.config', 'shipwords');

/** Lists site and template directories. */
export function siteDirs(root = ROOT) {
  const result = [];
  for (const group of ['sites', 'templates']) {
    const dir = path.join(root, group);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.existsSync(path.join(full, 'site.config.ts'))) result.push({ group, name, dir: full });
    }
  }
  return result;
}

/** Reads a few fields from site.config.ts. Uses regexes instead of running TS so scripts need no build. */
export function readSiteConfig(dir) {
  const source = fs.readFileSync(path.join(dir, 'site.config.ts'), 'utf8');
  const pick = (key) => source.match(new RegExp(`\\b${key}:\\s*'([^']*)'`))?.[1] ?? null;
  return { id: pick('id'), name: pick('name'), url: pick('url') };
}

/** Reads the "Status: xxx" line in README.md. */
export function readStatus(dir) {
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) return null;
  return (
    fs
      .readFileSync(readme, 'utf8')
      .match(/^- \*\*Status\*\*: (.+)$/m)?.[1]
      ?.trim() ?? null
  );
}

/** Sets or replaces one variable in dotenv-formatted text. */
export function setVar(text, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  return pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
}

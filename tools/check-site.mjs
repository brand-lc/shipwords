#!/usr/bin/env node
// Usage: node ../../tools/check-site.mjs <site dir> (a site's pnpm check runs it after the build)
// Checks that a site has the files, routes and policy pages needed to launch, that the build has no zh messages, and that it imports no other site.
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_FILES = [
  'README.md',
  'DESIGN.md',
  'site.config.ts',
  'site.models.ts',
  'wrangler.jsonc',
  'src/server.ts',
];
const REQUIRED_ROUTES = [
  'src/routes/sitemap[.]xml.ts',
  'src/routes/robots[.]txt.ts',
  'src/routes/llms[.]txt.ts',
  'src/routes/api/webhooks/stripe.ts',
  'src/routes/api/auth/$.ts',
];
// Policy pages: required by payment providers and for complaints. Text lives in messages/legal; the template has TODO placeholders.
const LEGAL_PAGES = ['privacy', 'terms', 'refunds', 'dmca'];
const LEGAL_FILE = 'src/site/legal.tsx';

function walk(dir, files = [], pattern = /\.(ts|tsx)$/) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files, pattern);
    else if (pattern.test(entry.name)) files.push(full);
  }
  return files;
}

/** Chinese copy from messages/<block>/zh.json. Production ships English only, so none of it should be in the build. */
function zhMessages(dir) {
  const messages = path.join(dir, 'messages');
  if (!fs.existsSync(messages)) return [];
  const texts = [];
  for (const block of fs.readdirSync(messages)) {
    const file = path.join(messages, block, 'zh.json');
    if (!fs.existsSync(file)) continue;
    for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) {
      if (key !== '$schema' && typeof value === 'string' && /\p{Script=Han}{4,}/u.test(value))
        texts.push(value);
    }
  }
  return texts;
}

function checkBuild(dir) {
  // Only the browser bundle is checked: leaked messages always land there, while the server bundle keeps source comments that would false-positive.
  const dist = path.join(dir, 'dist', 'client');
  const texts = zhMessages(dir);
  if (!fs.existsSync(dist) || !texts.length) return [];
  // Match whole strings of at least 4 Han characters, so the dev-only language toggle and short words in shared packages do not hit.
  for (const file of walk(dist, [], /\.(js|mjs|html)$/)) {
    const source = fs.readFileSync(file, 'utf8');
    const hit = texts.find((text) => source.includes(text));
    if (hit)
      return [
        `Build output ${path.relative(dir, file)} contains a zh message (${hit}); production builds should use project.en.inlang only`,
      ];
  }
  return [];
}

function checkLegal(dir, isTemplate) {
  const problems = [];
  for (const page of LEGAL_PAGES) {
    if (!fs.existsSync(path.join(dir, `src/routes/${page}.tsx`)))
      problems.push(`Missing policy page src/routes/${page}.tsx`);
  }
  if (!fs.existsSync(path.join(dir, LEGAL_FILE)))
    return [...problems, `Missing ${LEGAL_FILE} (SUPPORT_EMAIL)`];
  if (isTemplate) return problems;
  const email = fs.readFileSync(path.join(dir, LEGAL_FILE), 'utf8').match(/SUPPORT_EMAIL = '([^']*)'/)?.[1];
  if (!email || email.endsWith('example.com'))
    problems.push(`${LEGAL_FILE} SUPPORT_EMAIL is still a placeholder`);
  for (const block of ['legal', 'common']) {
    const file = path.join(dir, 'messages', block, 'en.json');
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('TODO')) {
      problems.push(`messages/${block}/en.json still has TODO placeholders (policy text or update date)`);
    }
  }
  return problems;
}

export function checkSite(dir) {
  const problems = [];
  const isTemplate = path.resolve(dir).split(path.sep).includes('templates');
  for (const file of isTemplate ? REQUIRED_FILES.filter((f) => !f.endsWith('.md')) : REQUIRED_FILES) {
    if (!fs.existsSync(path.join(dir, file))) problems.push(`Missing ${file}`);
  }
  for (const route of REQUIRED_ROUTES) {
    if (!fs.existsSync(path.join(dir, route))) problems.push(`Missing route ${route}`);
  }
  if (!isTemplate && fs.existsSync(path.join(dir, 'wrangler.jsonc'))) {
    const wrangler = fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8');
    if (wrangler.includes('ai-site-template')) problems.push('wrangler.jsonc still has the template name');
    if (wrangler.includes('<set after wrangler d1 create'))
      problems.push('wrangler.jsonc database_id is not set');
  }
  if (!isTemplate && fs.existsSync(path.join(dir, 'site.config.ts'))) {
    if (fs.readFileSync(path.join(dir, 'site.config.ts'), 'utf8').includes('example.com')) {
      problems.push('site.config.ts url is still example.com');
    }
  }
  problems.push(...checkLegal(dir, isTemplate), ...checkBuild(dir));
  for (const file of fs.existsSync(path.join(dir, 'src')) ? walk(path.join(dir, 'src')) : []) {
    const source = fs.readFileSync(file, 'utf8');
    if (/from ['"](\.\.\/)+(sites|templates)\//.test(source) || /@shipwords\/(site|template)-/.test(source)) {
      problems.push(`${path.relative(dir, file)} imports another site`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const dir = path.resolve(process.argv[2] ?? '.');
  const problems = checkSite(dir);
  if (problems.length) {
    console.error(`Site check failed (${dir}):`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log('Site check passed');
}

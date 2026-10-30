#!/usr/bin/env node
// Usage: pnpm list-sites [--json]
// The site list is generated from code: each site's site.config.ts and the status line in its README.md. No separate ledger.
import { sitePort } from './dev-port.mjs';
import { readSiteConfig, readStatus, siteDirs } from './lib.mjs';

const rows = siteDirs()
  .filter((site) => site.group === 'sites')
  .map((site) => ({
    dir: `sites/${site.name}`,
    ...readSiteConfig(site.dir),
    devPort: sitePort(site.dir),
    status: readStatus(site.dir),
  }));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else if (rows.length === 0) {
  console.log('No sites yet. Create one with pnpm new-site <dir>.');
} else {
  for (const row of rows)
    console.log(`${row.dir}\t:${row.devPort}\t${row.url ?? '-'}\t${row.status ?? 'no status'}`);
}

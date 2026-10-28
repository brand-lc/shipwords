# shipwords.dev

The project's one-page website: what shipwords is, a quick start, the Tiny Desk AI example (tinydeskai.io and its source). Static pages in `public/`, served by Workers static assets; a small Worker (`src/worker.ts`) only proxies `/stats/*` to Rybbit. No site logic, and no secrets in the repo.

Two languages: English at `/` (`public/index.html`) and Chinese at `/zh/` (`public/zh/index.html`). Both share `site.css` and `site.js`; keep the two pages in sync and their hreflang links pointing at each other.

```bash
pnpm --filter @shipwords/www dev      # http://localhost:6190
pnpm --filter @shipwords/www run deploy   # production, needs confirmation
```

Every outbound link carries `utm_source=shipwords` so Yir and tinydeskai.io can attribute traffic.

Analytics: `public/analytics.js` loads GA4 and Rybbit on the production host only. Rybbit goes through `/stats/*`, the only path the Worker (`src/worker.ts`) handles; it proxies to the `RYBBIT_UPSTREAM` secret. Search Console and Bing Webmaster Tools are verified by DNS records on the shipwords.dev zone.

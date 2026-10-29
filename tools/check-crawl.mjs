import { pathToFileURL } from 'node:url';

export const USER_AGENTS = {
  browser: 'Mozilla/5.0 (compatible; ShipwordsLaunchCheck/1.0)',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  bingbot: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  search: 'OAI-SearchBot/1.0',
};

function attrs(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map((m) => [
      m[1].toLowerCase(),
      m[2] ?? m[3] ?? m[4],
    ]),
  );
}

/** Smoke checks for our generated HTML, not a general HTML/robots parser or index verdict. */
export function inspectHtml(html, expectedUrl, headers = new Headers(), requiredText = []) {
  const errors = [];
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  const document = markup.replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const meta = [...document.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0]));
  const links = [...document.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0]));
  if (headers.get('cf-mitigated') === 'challenge') errors.push('Cloudflare challenge');
  if (/\b(noindex|none)\b/i.test(headers.get('x-robots-tag') ?? ''))
    errors.push('X-Robots-Tag blocks indexing');
  if (
    meta.some(
      (m) =>
        /^(robots|googlebot|bingbot)$/i.test(m.name ?? '') && /\b(noindex|none)\b/i.test(m.content ?? ''),
    )
  )
    errors.push('Meta robots blocks indexing');
  if (!/<title\b[^>]*>\s*[^<]+<\/title>/i.test(document)) errors.push('Missing title');
  if (!meta.some((m) => m.name?.toLowerCase() === 'description' && m.content?.trim()))
    errors.push('Missing description');
  const canonicals = links.filter((l) => l.rel?.toLowerCase() === 'canonical');
  try {
    if (canonicals.length !== 1 || new URL(canonicals[0].href).href !== new URL(expectedUrl).href)
      errors.push('Canonical does not match requested URL');
  } catch {
    errors.push('Invalid canonical');
  }
  if (!/<h1\b[^>]*>[\s\S]*?\S[\s\S]*?<\/h1>/i.test(document)) errors.push('Missing SSR H1');
  const body = document.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? '';
  const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  for (const phrase of requiredText) if (!text.includes(phrase)) errors.push(`Missing SSR text: ${phrase}`);
  for (const match of markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (attrs(match[1]).type !== 'application/ld+json') continue;
    try {
      const visit = (value) => {
        if (!value || typeof value !== 'object') return;
        if (
          [value['@type']].flat().includes('VideoObject') &&
          (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
            value.uploadDate ?? '',
          ) ||
            !Number.isFinite(Date.parse(value.uploadDate)))
        )
          errors.push('Video uploadDate needs a valid datetime with timezone');
        for (const child of Object.values(value)) visit(child);
      };
      visit(JSON.parse(match[2]));
    } catch {
      errors.push('Invalid JSON-LD');
    }
  }
  return errors;
}

/** Exactly twelve GETs, no cookies, no mutations, no external redirect following. */
export async function checkCrawl(origin, requiredText = [], fetcher = fetch) {
  const base = new URL(origin);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash
  )
    throw new Error('Provide an HTTPS origin, without credentials, path, query or fragment');
  const results = [];
  for (const [agent, userAgent] of Object.entries(USER_AGENTS)) {
    for (const path of ['/', '/robots.txt', '/sitemap.xml']) {
      const url = new URL(path, base).href;
      try {
        const response = await fetcher(url, {
          headers: { 'user-agent': userAgent },
          redirect: 'manual',
          signal: AbortSignal.timeout(15000),
        });
        const body = await response.text();
        const errors = [];
        if (response.status !== 200) errors.push(`HTTP ${response.status}`);
        if (response.headers.get('cf-mitigated') === 'challenge') errors.push('Cloudflare challenge');
        if (path === '/') {
          if (!/text\/html/i.test(response.headers.get('content-type') ?? '')) errors.push('Expected HTML');
          errors.push(...inspectHtml(body, url, response.headers, requiredText));
        } else if (path === '/robots.txt') {
          if (!/^user-agent\s*:/im.test(body)) errors.push('Missing robots user-agent groups');
          if (!body.includes(new URL('/sitemap.xml', base).href)) errors.push('Missing sitemap declaration');
        } else {
          if (
            !/<urlset\b[^>]*xmlns=["']http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9["']/i.test(body) ||
            !/<\/urlset>/i.test(body)
          )
            errors.push('Expected sitemap urlset');
          const urls = [...body.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g)].map((m) => m[1].trim());
          if (!urls.length) errors.push('Empty sitemap');
          for (const loc of urls) {
            try {
              if (new URL(loc).origin !== base.origin) errors.push(`Foreign sitemap URL: ${loc}`);
            } catch {
              errors.push(`Invalid sitemap URL: ${loc}`);
            }
          }
        }
        results.push({
          agent,
          url,
          status: response.status,
          location: response.headers.get('location'),
          errors,
          ...(path === '/robots.txt' ? { robots: body } : {}),
        });
      } catch (error) {
        results.push({ agent, url, errors: [error.message] });
      }
    }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const results = await checkCrawl(process.argv[2], process.argv.slice(3));
    console.log(
      JSON.stringify(
        {
          note: 'UA simulation only. Review robots rules manually; use GSC/Bing inspection for real crawler and index evidence. Repeat from independent networks. This is not an XML or HTML validator.',
          results,
        },
        null,
        2,
      ),
    );
    process.exitCode = results.some((r) => r.errors.length) ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import type { SiteConfig } from './site';

// Analytics scripts. Rybbit goes through the site's own /stats/ path, proxied by the Worker to RYBBIT_UPSTREAM:
// the shared collector domain never appears in pages, browser requests or DNS, so sites can't be linked through it.

export const RYBBIT_PATH = '/stats';

/** Returns scripts for TanStack Router head(); sites skip this in local dev themselves. */
export function analyticsScripts(site: SiteConfig) {
  const scripts: Record<string, unknown>[] = [];
  const ga4 = site.analytics?.ga4;
  if (ga4) {
    scripts.push(
      { src: `https://www.googletagmanager.com/gtag/js?id=${ga4}`, async: true },
      {
        children: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${ga4}');`,
      },
    );
  }
  const rybbit = site.analytics?.rybbit;
  // Rybbit treats everything in src before /script.js as the reporting endpoint, so events also land under /stats/.
  if (rybbit) scripts.push({ src: `${RYBBIT_PATH}/script.js?siteId=${rybbit.siteId}`, defer: true });
  return scripts;
}

/** Proxies /stats/* to Rybbit; returns null for other paths so the site keeps handling them. */
export async function proxyRybbit(
  request: Request,
  upstream: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${RYBBIT_PATH}/`)) return null;
  if (!upstream) return new Response(null, { status: 404 });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'GET' && request.method !== 'POST') return new Response(null, { status: 405 });

  const headers = new Headers();
  for (const name of ['content-type', 'user-agent', 'accept-language', 'origin', 'referer']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Rybbit geolocates by visitor IP; cookies aren't forwarded.
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('x-forwarded-for', ip);

  const target = `${upstream.replace(/\/$/, '')}${url.pathname.slice(RYBBIT_PATH.length)}${url.search}`;
  const response = await fetcher(target, {
    method: request.method,
    headers,
    body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
  });
  const out = new Headers();
  for (const name of ['content-type', 'cache-control']) {
    const value = response.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers: out });
}

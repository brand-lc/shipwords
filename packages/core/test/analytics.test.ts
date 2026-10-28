import { describe, expect, it } from 'vitest';
import { analyticsScripts, proxyRybbit } from '../src/analytics';
import type { SiteConfig } from '../src/site';

const UPSTREAM = 'https://events.example.com/api';

function recorder() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('ok', {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': 'a=b', 'cache-control': 'no-store' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

describe('Rybbit same-origin proxy', () => {
  it('ignores paths outside /stats/', async () => {
    const { calls, fetcher } = recorder();
    expect(await proxyRybbit(new Request('https://site.io/api/track'), UPSTREAM, fetcher)).toBeNull();
    expect(await proxyRybbit(new Request('https://site.io/statsx/track'), UPSTREAM, fetcher)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('forwards events to the collector with the visitor IP, without cookies, and strips set-cookie from the response', async () => {
    const { calls, fetcher } = recorder();
    const request = new Request('https://site.io/stats/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=1', 'cf-connecting-ip': '1.2.3.4' },
      body: '{"site_id":"x"}',
    });
    const response = await proxyRybbit(request, `${UPSTREAM}/`, fetcher);
    expect(calls[0]?.url).toBe('https://events.example.com/api/track');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('x-forwarded-for')).toBe('1.2.3.4');
    expect(headers.get('cookie')).toBeNull();
    expect(new TextDecoder().decode(calls[0]?.init.body as ArrayBuffer)).toBe('{"site_id":"x"}');
    expect(response?.status).toBe(200);
    expect(response?.headers.get('set-cookie')).toBeNull();
    expect(response?.headers.get('content-type')).toBe('application/json');
  });

  it('script and config requests keep the query string', async () => {
    const { calls, fetcher } = recorder();
    await proxyRybbit(new Request('https://site.io/stats/script.js?siteId=abc'), UPSTREAM, fetcher);
    expect(calls[0]?.url).toBe('https://events.example.com/api/script.js?siteId=abc');
  });

  it('returns 404 without a collector URL and rejects other methods', async () => {
    const { fetcher } = recorder();
    expect((await proxyRybbit(new Request('https://site.io/stats/track'), undefined, fetcher))?.status).toBe(
      404,
    );
    const put = new Request('https://site.io/stats/track', { method: 'PUT', body: 'x' });
    expect((await proxyRybbit(put, UPSTREAM, fetcher))?.status).toBe(405);
  });
});

describe('analytics script', () => {
  it('Rybbit script uses a site-relative path and the collector domain never appears in the page', () => {
    const site = { analytics: { ga4: 'G-TEST', rybbit: { siteId: 'abc' } } } as unknown as SiteConfig;
    const scripts = analyticsScripts(site);
    expect(scripts).toContainEqual({ src: '/stats/script.js?siteId=abc', defer: true });
    expect(JSON.stringify(scripts)).toContain('G-TEST');
    expect(analyticsScripts({ analytics: {} } as unknown as SiteConfig)).toEqual([]);
  });
});

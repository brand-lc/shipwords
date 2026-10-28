import type { Db } from '../db/client';
import { clientIp, ipBucket, readCookie } from '../http';
import type { GuestQuota } from '../site';
import { consumeQuota, dayWindow, type QuotaRule } from './counters';
import { type RecaptchaConfig, verifyRecaptcha } from './recaptcha';

// Guest free trial: three counters (signed device cookie, IP, site-wide daily budget) plus a reCAPTCHA score.
// The captcha only raises the bar; the counters are the real backstop.

const GUEST_COOKIE_MAX_AGE = 400 * 86_400;

export function guestCookieName(siteId: string) {
  return `${siteId}_gid`;
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Reads the signed guest ID; returns null if missing or the signature is invalid. */
export async function readGuestId(headers: Headers, siteId: string, secret: string): Promise<string | null> {
  const raw = readCookie(headers, guestCookieName(siteId));
  if (!raw) return null;
  const [id, signature] = raw.split('.');
  if (!id || !signature) return null;
  return timingSafeEqual(await hmac(secret, id), signature) ? id : null;
}

/** Returns the guest ID, creating one if missing along with the Set-Cookie to send back. */
export async function ensureGuestId(
  headers: Headers,
  siteId: string,
  secret: string,
): Promise<{ guestId: string; setCookie: string | null }> {
  const existing = await readGuestId(headers, siteId, secret);
  if (existing) return { guestId: existing, setCookie: null };
  const guestId = `g_${crypto.randomUUID().replaceAll('-', '')}`;
  const value = `${guestId}.${await hmac(secret, guestId)}`;
  const setCookie = `${guestCookieName(siteId)}=${value}; Path=/; Max-Age=${GUEST_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
  return { guestId, setCookie };
}

export type GuestDecision =
  | { ok: true; guestId: string; setCookie: string | null; rules: QuotaRule[] }
  | { ok: false; reason: 'recaptcha' | 'quota'; setCookie: string | null };

export interface GuestCheckInput {
  db: Db;
  request: Request;
  siteId: string;
  quota: GuestQuota;
  recaptcha: RecaptchaConfig;
  recaptchaToken: string | null | undefined;
  action: string;
  cookieSecret: string;
  fetcher?: typeof fetch;
}

/**
 * Decides whether this guest can generate for free. On success one unit is already consumed;
 * if submission fails afterwards, call releaseQuota(db, decision.rules) to refund it.
 */
export async function authorizeGuest(input: GuestCheckInput): Promise<GuestDecision> {
  const { guestId, setCookie } = await ensureGuestId(input.request.headers, input.siteId, input.cookieSecret);
  const check = await verifyRecaptcha(
    input.recaptcha,
    input.recaptchaToken,
    input.action,
    input.quota.minRecaptchaScore,
    input.fetcher,
  );
  if (!check.ok) return { ok: false, reason: 'recaptcha', setCookie };

  const window = dayWindow();
  const ip = clientIp(input.request.headers);
  const deviceRules: QuotaRule[] = [
    { key: `guest:device:${guestId}`, window, limit: input.quota.dailyPerDevice },
    ...(ip ? [{ key: `guest:ip:${ipBucket(ip)}`, window, limit: input.quota.dailyPerIp }] : []),
  ];
  // Site-wide budget goes last so requests already capped by device or IP don't consume it. If any rule fails, earlier increments are rolled back.
  const rules = [...deviceRules, { key: 'guest:site', window, limit: input.quota.dailySiteBudget }];
  if (!(await consumeQuota(input.db, rules))) return { ok: false, reason: 'quota', setCookie };
  return { ok: true, guestId, setCookie, rules };
}

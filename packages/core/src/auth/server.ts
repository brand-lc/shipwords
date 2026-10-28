import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { emailOTP, oneTap } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import { grantCredits } from '../credits/ledger';
import type { Db } from '../db/client';
import * as schema from '../db/schema';
import type { CoreEnv } from '../env';
import { clientIp, ipBucket } from '../http';
import { consumeQuota, dayWindow } from '../quota/counters';
import type { SiteConfig } from '../site';
import { isDisposableEmail } from './disposable';

const DAY = 86_400_000;
export const ATTRIBUTION_COOKIE = 'sh_attr';

export interface AuthDeps {
  db: Db;
  env: CoreEnv;
  site: SiteConfig;
  baseURL: string;
  log: (message: string, details: Record<string, unknown>) => void;
}

function readAttribution(headers: Headers | undefined) {
  const cookie = headers?.get('cookie') ?? '';
  const raw = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ATTRIBUTION_COOKIE}=`));
  if (!raw) return null;
  try {
    const value = JSON.parse(decodeURIComponent(raw.slice(ATTRIBUTION_COOKIE.length + 1)));
    const pick = (key: string) =>
      typeof value?.[key] === 'string' ? String(value[key]).slice(0, 200) : null;
    return {
      utmSource: pick('utm_source'),
      utmMedium: pick('utm_medium'),
      utmCampaign: pick('utm_campaign'),
      referrer: pick('referrer'),
      landingPath: pick('landing_path'),
    };
  } catch {
    return null;
  }
}

/** Sign-up bonus: verified emails only, capped per IP per day, once per user. */
async function grantSignupBonus(deps: AuthDeps, userId: string, headers: Headers | undefined) {
  const { bonusCredits, bonusExpiresDays, bonusPerIpDaily } = deps.site.signup;
  if (bonusCredits <= 0) return;
  const idemKey = `signup:${userId}`;
  const already = await deps.db.query.creditLedger.findFirst({
    where: eq(schema.creditLedger.idemKey, idemKey),
  });
  if (already) return;
  const ip = headers ? clientIp(headers) : null;
  if (ip) {
    const ok = await consumeQuota(deps.db, [
      { key: `signup-bonus:ip:${ipBucket(ip)}`, window: dayWindow(), limit: bonusPerIpDaily },
    ]);
    if (!ok) {
      deps.log('signup bonus skipped: ip limit', { userId });
      return;
    }
  }
  await grantCredits(deps.db, {
    userId,
    amount: bonusCredits,
    idemKey,
    source: 'signup',
    expiresAt: bonusExpiresDays == null ? null : Date.now() + bonusExpiresDays * DAY,
  });
}

export function createAuth(deps: AuthDeps) {
  const { db, env, site } = deps;
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
      : {};

  return betterAuth({
    appName: site.name,
    baseURL: deps.baseURL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        rateLimit: schema.rateLimit,
      },
    }),
    socialProviders: google,
    account: {
      // Only auto-link Google accounts (Google returns verified emails), so nobody can take over someone else's account with an unverified email.
      accountLinking: { enabled: true, trustedProviders: ['google'] },
    },
    rateLimit: { enabled: true, storage: 'database' },
    advanced: {
      // Keeps cookies separate when several sites run locally at once.
      cookiePrefix: site.id,
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        async sendVerificationOTP({ email, otp }) {
          await env.EMAIL.send({
            to: email,
            from: { email: env.EMAIL_FROM, name: site.name },
            subject: `${otp} is your ${site.name} code`,
            text: `Your ${site.name} sign-in code is ${otp}. It expires in 10 minutes.`,
            html: `<p>Your ${site.name} sign-in code is <strong style="font-size:20px">${otp}</strong>.</p><p>It expires in 10 minutes.</p>`,
          });
        },
      }),
      ...(google.google ? [oneTap()] : []),
    ],
    databaseHooks: {
      user: {
        create: {
          async before(user) {
            if (isDisposableEmail(user.email)) {
              throw new APIError('BAD_REQUEST', { message: 'Please use a permanent email address.' });
            }
          },
          async after(user, context) {
            const headers = context?.request?.headers ?? context?.headers;
            const attribution = readAttribution(headers);
            const ip = headers ? clientIp(headers) : null;
            await db
              .insert(schema.userAttribution)
              .values({ userId: user.id, ...attribution, signupIp: ip })
              .onConflictDoNothing();
            if (user.emailVerified) await grantSignupBonus(deps, user.id, headers);
          },
        },
        update: {
          async after(user, context) {
            if (!user.emailVerified) return;
            await grantSignupBonus(deps, user.id, context?.request?.headers ?? context?.headers);
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

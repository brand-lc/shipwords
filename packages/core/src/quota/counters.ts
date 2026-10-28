import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { quotaCounters } from '../db/schema';

export interface QuotaRule {
  key: string;
  /** Counting window, e.g. the UTC date from dayWindow(). */
  window: string;
  limit: number;
}

export function dayWindow(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function increment(db: Db, rule: QuotaRule): Promise<boolean> {
  if (rule.limit <= 0) return false;
  const result = await db
    .insert(quotaCounters)
    .values({ key: rule.key, window: rule.window, count: 1 })
    .onConflictDoUpdate({
      target: [quotaCounters.key, quotaCounters.window],
      set: { count: sql`${quotaCounters.count} + 1` },
      setWhere: sql`${quotaCounters.count} < ${rule.limit}`,
    })
    .run();
  return result.meta.changes > 0;
}

async function decrement(db: Db, rule: QuotaRule) {
  await db
    .update(quotaCounters)
    .set({ count: sql`max(${quotaCounters.count} - 1, 0)` })
    .where(and(eq(quotaCounters.key, rule.key), eq(quotaCounters.window, rule.window)));
}

/**
 * Increments each rule in turn; if any is at its limit, rolls back earlier increments and returns false.
 * Each increment is a single conditional upsert, so concurrency can't exceed the limit.
 */
export async function consumeQuota(db: Db, rules: QuotaRule[]): Promise<boolean> {
  const done: QuotaRule[] = [];
  for (const rule of rules) {
    if (await increment(db, rule)) {
      done.push(rule);
      continue;
    }
    await Promise.all(done.map((previous) => decrement(db, previous)));
    return false;
  }
  return true;
}

/** Refunds one count, e.g. when a guest generation fails to submit. */
export async function releaseQuota(db: Db, rules: QuotaRule[]): Promise<void> {
  await Promise.all(rules.map((rule) => decrement(db, rule)));
}

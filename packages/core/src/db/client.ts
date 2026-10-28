import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export type Db = DrizzleD1Database<typeof schema>;

export function createDb(d1: D1Database): Db {
  return drizzle(d1, { schema });
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

type ConstraintKind = 'UNIQUE' | 'CHECK';

/** drizzle wraps D1 constraint errors a few layers deep; walk the cause chain for the original message. */
export function isConstraintError(error: unknown, kind: ConstraintKind, target?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    if (message.includes(`${kind} constraint failed`) && (!target || message.includes(target))) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/** Element type of a D1 batch: any unexecuted drizzle query. */
export type BatchItem = Parameters<Db['batch']>[0][number];

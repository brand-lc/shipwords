import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { type BatchItem, type Db, isConstraintError, newId } from '../db/client';
import { creditAccounts, creditAllocations, creditLedger, creditLots } from '../db/schema';

// The only write entry points for the credit ledger. Rules:
// - One idempotency key per operation; if the key exists, treat it as done and return applied=false;
// - All writes of an operation (including caller-supplied extra) go into one D1 batch;
// - Per-user optimistic lock: read the account version, then the lots; the batch checks the version is unchanged and increments it.
//   If any other ledger operation for the same user slips in between read and write, the whole batch fails and is re-read and retried.
//   CHECK constraints (remaining and debt non-negative) are the backstop.

const MAX_ATTEMPTS = 8;
/** On version mismatch, sets debt to a value that must violate CHECK so the whole batch rolls back. */
const VERSION_CONFLICT = 1_000_000_000_000;

export class InsufficientCreditsError extends Error {
  constructor(
    readonly required: number,
    readonly available: number,
  ) {
    super(`insufficient credits: required ${required}, available ${available}`);
    this.name = 'InsufficientCreditsError';
  }
}

export interface LedgerResult {
  /** false means the idempotency key already existed and nothing was written. */
  applied: boolean;
  ledgerId: string | null;
}

interface ActiveLot {
  id: string;
  remaining: number;
  sourceRef: string | null;
}

function assertPositiveInt(amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error(`credit amount must be a positive integer: ${amount}`);
}

async function activeLots(db: Db, userId: string, now: number): Promise<ActiveLot[]> {
  return (
    db
      .select({ id: creditLots.id, remaining: creditLots.remaining, sourceRef: creditLots.sourceRef })
      .from(creditLots)
      .where(
        and(
          eq(creditLots.userId, userId),
          gt(creditLots.remaining, 0),
          or(isNull(creditLots.expiresAt), gt(creditLots.expiresAt, now)),
        ),
      )
      // Earliest expiry first, never-expiring last (SQLite sorts NULL first by default, so handle it explicitly).
      .orderBy(sql`${creditLots.expiresAt} is null`, asc(creditLots.expiresAt), asc(creditLots.createdAt))
  );
}

async function currentDebt(db: Db, userId: string): Promise<number> {
  const row = await db.query.creditAccounts.findFirst({ where: eq(creditAccounts.userId, userId) });
  return row?.debt ?? 0;
}

async function findLedger(db: Db, idemKey: string) {
  return db.query.creditLedger.findFirst({ where: eq(creditLedger.idemKey, idemKey) });
}

interface AccountState {
  debt: number;
  version: number;
}

/** Reads the account (creating it if missing); must be called before reading lots. */
async function readAccount(db: Db, userId: string): Promise<AccountState> {
  await db.insert(creditAccounts).values({ userId }).onConflictDoNothing();
  const row = await db.query.creditAccounts.findFirst({ where: eq(creditAccounts.userId, userId) });
  return { debt: row?.debt ?? 0, version: row?.version ?? 0 };
}

/** Checks the version is unchanged, increments it and updates debt. If the version changed, debt goes negative and CHECK rolls back the batch. */
function commitAccount(db: Db, userId: string, account: AccountState, debtChange: number): BatchItem {
  const conflict = sql`(case when ${creditAccounts.version} = ${account.version} then 0 else ${VERSION_CONFLICT} end)`;
  return db
    .update(creditAccounts)
    .set({
      debt: sql`${creditAccounts.debt} + ${debtChange} - ${conflict}`,
      version: sql`${creditAccounts.version} + 1`,
      updatedAt: Date.now(),
    })
    .where(eq(creditAccounts.userId, userId));
}

/** Takes up to amount from lots in order and returns how much each lot gives; returns what's available if short. */
function allocate(lots: ActiveLot[], amount: number): { lotId: string; amount: number }[] {
  const plan: { lotId: string; amount: number }[] = [];
  let left = amount;
  for (const lot of lots) {
    if (left === 0) break;
    const take = Math.min(lot.remaining, left);
    plan.push({ lotId: lot.id, amount: take });
    left -= take;
  }
  return plan;
}

async function runIdempotent(
  db: Db,
  idemKey: string,
  build: () => Promise<{ ledgerId: string; items: BatchItem[] }>,
): Promise<LedgerResult> {
  for (let attempt = 1; ; attempt++) {
    const { ledgerId, items } = await build();
    try {
      await db.batch(items as [BatchItem, ...BatchItem[]]);
      return { applied: true, ledgerId };
    } catch (error) {
      if (isConstraintError(error, 'UNIQUE', 'credit_ledger.idem_key')) {
        const existing = await findLedger(db, idemKey);
        return { applied: false, ledgerId: existing?.id ?? null };
      }
      if (isConstraintError(error, 'CHECK') && attempt < MAX_ATTEMPTS) {
        // On conflict, wait briefly before re-reading so concurrent requests don't keep colliding.
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * attempt));
        continue;
      }
      throw error;
    }
  }
}

export interface GrantInput {
  userId: string;
  amount: number;
  idemKey: string;
  source: string;
  sourceRef?: string | null;
  /** Millisecond timestamp; null or omitted means never expires. */
  expiresAt?: number | null;
  ref?: string | null;
}

/** Grants credits. If the user has debt, it's repaid first and only the rest becomes available. */
export async function grantCredits(
  db: Db,
  input: GrantInput,
  extra: BatchItem[] = [],
): Promise<LedgerResult> {
  assertPositiveInt(input.amount);
  return runIdempotent(db, input.idemKey, async () => {
    const account = await readAccount(db, input.userId);
    const debtPay = Math.min(account.debt, input.amount);
    const ledgerId = newId('cl');
    const items: BatchItem[] = [
      db.insert(creditLedger).values({
        id: ledgerId,
        userId: input.userId,
        kind: 'grant',
        delta: input.amount,
        debtDelta: -debtPay,
        idemKey: input.idemKey,
        ref: input.ref ?? input.sourceRef ?? null,
      }),
      db.insert(creditLots).values({
        id: newId('lot'),
        userId: input.userId,
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        amount: input.amount,
        remaining: input.amount - debtPay,
        expiresAt: input.expiresAt ?? null,
      }),
      commitAccount(db, input.userId, account, -debtPay),
    ];
    items.push(...extra);
    return { ledgerId, items };
  });
}

export interface SpendInput {
  userId: string;
  amount: number;
  idemKey: string;
  ref?: string | null;
}

/** Charges credits, earliest-expiring lots first. Throws InsufficientCreditsError on low balance and writes nothing. */
export async function spendCredits(
  db: Db,
  input: SpendInput,
  extra: BatchItem[] = [],
): Promise<LedgerResult> {
  assertPositiveInt(input.amount);
  return runIdempotent(db, input.idemKey, async () => {
    const account = await readAccount(db, input.userId);
    const debt = account.debt;
    const lots = await activeLots(db, input.userId, Date.now());
    const total = lots.reduce((sum, lot) => sum + lot.remaining, 0);
    if (total - debt < input.amount) {
      // A duplicate request with an already-used idempotency key shouldn't report insufficient balance.
      const existing = await findLedger(db, input.idemKey);
      if (existing) throw new AlreadyAppliedSignal(existing.id);
      throw new InsufficientCreditsError(input.amount, Math.max(0, total - debt));
    }
    const ledgerId = newId('cl');
    const items: BatchItem[] = [
      commitAccount(db, input.userId, account, 0),
      db.insert(creditLedger).values({
        id: ledgerId,
        userId: input.userId,
        kind: 'spend',
        delta: -input.amount,
        idemKey: input.idemKey,
        ref: input.ref ?? null,
      }),
    ];
    for (const part of allocate(lots, input.amount)) {
      items.push(
        db
          .update(creditLots)
          .set({ remaining: sql`${creditLots.remaining} - ${part.amount}` })
          .where(eq(creditLots.id, part.lotId)),
        db.insert(creditAllocations).values({ ledgerId, lotId: part.lotId, amount: part.amount }),
      );
    }
    items.push(...extra);
    return { ledgerId, items };
  }).catch((error) => {
    if (error instanceof AlreadyAppliedSignal) return { applied: false, ledgerId: error.ledgerId };
    throw error;
  });
}

class AlreadyAppliedSignal extends Error {
  constructor(readonly ledgerId: string) {
    super('already applied');
  }
}

export interface RefundSpendInput {
  /** Idempotency key of the original charge. */
  spendIdemKey: string;
  idemKey: string;
  ref?: string | null;
}

/**
 * Refunds a charge (e.g. a failed task) back to the original lots. Returns applied=false if the charge doesn't exist.
 * If the user has debt, the refunded credits repay it first and only the remainder goes back to lots;
 * otherwise we'd leave "credits in lots + equal debt", and later grants would repay the debt, effectively giving new credits the old lots' expiry.
 */
export async function refundSpend(
  db: Db,
  input: RefundSpendInput,
  extra: BatchItem[] = [],
): Promise<LedgerResult> {
  const spend = await findLedger(db, input.spendIdemKey);
  if (spend?.kind !== 'spend') return { applied: false, ledgerId: null };
  const parts = await db.select().from(creditAllocations).where(eq(creditAllocations.ledgerId, spend.id));
  return runIdempotent(db, input.idemKey, async () => {
    const account = await readAccount(db, spend.userId);
    const debtPay = Math.min(account.debt, -spend.delta);
    const ledgerId = newId('cl');
    const items: BatchItem[] = [
      commitAccount(db, spend.userId, account, -debtPay),
      db.insert(creditLedger).values({
        id: ledgerId,
        userId: spend.userId,
        kind: 'refund',
        delta: -spend.delta,
        debtDelta: -debtPay,
        idemKey: input.idemKey,
        ref: input.ref ?? spend.ref,
      }),
    ];
    let toDebt = debtPay;
    for (const part of parts) {
      const kept = Math.min(toDebt, part.amount);
      toDebt -= kept;
      if (part.amount - kept === 0) continue;
      items.push(
        db
          .update(creditLots)
          .set({ remaining: sql`${creditLots.remaining} + ${part.amount - kept}` })
          .where(eq(creditLots.id, part.lotId)),
      );
    }
    items.push(...extra);
    return { ledgerId, items };
  });
}

export interface RevokeInput {
  userId: string;
  amount: number;
  idemKey: string;
  /** Claw back from lots of this source first (usually the lots granted by this payment). */
  preferSourceRef?: string | null;
  ref?: string | null;
}

/** Claws back credits (refunds, chargebacks). Whatever the lots can't cover becomes debt, so balance can go negative. */
export async function revokeCredits(
  db: Db,
  input: RevokeInput,
  extra: BatchItem[] = [],
): Promise<LedgerResult> {
  assertPositiveInt(input.amount);
  return runIdempotent(db, input.idemKey, async () => {
    const account = await readAccount(db, input.userId);
    const lots = await activeLots(db, input.userId, Date.now());
    const preferred = input.preferSourceRef
      ? lots.filter((lot) => lot.sourceRef === input.preferSourceRef)
      : [];
    const ordered = [...preferred, ...lots.filter((lot) => !preferred.includes(lot))];
    const plan = allocate(ordered, input.amount);
    const taken = plan.reduce((sum, part) => sum + part.amount, 0);
    const debtAdd = input.amount - taken;
    const ledgerId = newId('cl');
    const items: BatchItem[] = [
      commitAccount(db, input.userId, account, debtAdd),
      db.insert(creditLedger).values({
        id: ledgerId,
        userId: input.userId,
        kind: 'revoke',
        delta: -input.amount,
        debtDelta: debtAdd,
        idemKey: input.idemKey,
        ref: input.ref ?? null,
      }),
    ];
    for (const part of plan) {
      items.push(
        db
          .update(creditLots)
          .set({ remaining: sql`${creditLots.remaining} - ${part.amount}` })
          .where(eq(creditLots.id, part.lotId)),
        db.insert(creditAllocations).values({ ledgerId, lotId: part.lotId, amount: part.amount }),
      );
    }
    items.push(...extra);
    return { ledgerId, items };
  });
}

export interface Balance {
  /** Available balance; may be negative (debt). */
  available: number;
  debt: number;
  /** Nearest expiry time and amount, for hints like "X credits expire on <date>". */
  nextExpiry: { at: number; amount: number } | null;
}

export async function getBalance(db: Db, userId: string, now = Date.now()): Promise<Balance> {
  const [lots, debt] = await Promise.all([
    db
      .select({ remaining: creditLots.remaining, expiresAt: creditLots.expiresAt })
      .from(creditLots)
      .where(
        and(
          eq(creditLots.userId, userId),
          gt(creditLots.remaining, 0),
          or(isNull(creditLots.expiresAt), gt(creditLots.expiresAt, now)),
        ),
      ),
    currentDebt(db, userId),
  ]);
  const total = lots.reduce((sum, lot) => sum + lot.remaining, 0);
  let nextExpiry: Balance['nextExpiry'] = null;
  for (const lot of lots) {
    if (lot.expiresAt == null) continue;
    if (!nextExpiry || lot.expiresAt < nextExpiry.at)
      nextExpiry = { at: lot.expiresAt, amount: lot.remaining };
    else if (lot.expiresAt === nextExpiry.at) nextExpiry.amount += lot.remaining;
  }
  return { available: total - debt, debt, nextExpiry };
}

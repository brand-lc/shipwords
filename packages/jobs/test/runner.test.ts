import { env } from 'cloudflare:test';
import { getBalance, grantCredits, spendCredits } from '@shipwords/core/credits/ledger';
import { createDb } from '@shipwords/core/db/client';
import { user } from '@shipwords/core/db/schema';
import { consumeQuota } from '@shipwords/core/quota/counters';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { loadJob, markFailed, markSucceeded, spendKey } from '../src/lifecycle';
import { defineModels } from '../src/models';
import { emailOnSuccess } from '../src/notify';
import { runGeneration, type StepRunner } from '../src/runner';
import { jobs } from '../src/schema';
import { type PollResult, type SubmitInput, type UpstreamAdapter, UpstreamError } from '../src/upstream';
import { buildYirRequest, YirAdapter } from '../src/yir';

const db = createDb(env.DB);

const models = defineModels([
  {
    id: 'fast',
    name: 'Fast',
    kind: 'image',
    upstream: 'yir',
    upstreamModel: 'vendor/fast',
    credits: 10,
    guest: true,
    allowedParameters: ['aspect_ratio'],
    maxReferences: 1,
    timeoutMinutes: 10,
  },
]);

class FakeAdapter implements UpstreamAdapter {
  readonly name = 'yir';
  submits: { input: SubmitInput; key: string }[] = [];
  polls: PollResult[] = [];
  cancelled: string[] = [];
  submitError: Error | null = null;
  async submit(input: SubmitInput, key: string) {
    if (this.submitError) throw this.submitError;
    this.submits.push({ input, key });
    return { upstreamJobId: `up_${key}` };
  }
  async poll() {
    return this.polls.shift() ?? { state: 'running' as const };
  }
  async cancel(id: string) {
    this.cancelled.push(id);
  }
}

/** StepRunner that runs directly and records step names for assertions. */
function immediateSteps(names: string[] = []): StepRunner {
  return {
    async do(name, fn) {
      names.push(name);
      return fn();
    },
    async sleep(name) {
      names.push(name);
    },
  };
}

const outputFetcher: typeof fetch = async () =>
  new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });

async function paidJob(cost = 10, overrides: Partial<typeof jobs.$inferInsert> = {}) {
  const userId = `u_${crypto.randomUUID().slice(0, 10)}`;
  const jobId = `job_${crypto.randomUUID().replaceAll('-', '')}`;
  await grantCredits(db, { userId, amount: 50, idemKey: `g:${userId}`, source: 'test' });
  await spendCredits(db, { userId, amount: cost, idemKey: spendKey(jobId) }, [
    db.insert(jobs).values({
      id: jobId,
      userId,
      modelId: 'fast',
      kind: 'image',
      prompt: 'a cat',
      inputJson: JSON.stringify({ references: [], parameters: { aspect_ratio: '1:1' } }),
      costCredits: cost,
      upstream: 'yir',
      ...overrides,
    }),
  ]);
  return { userId, jobId };
}

const deps = (adapter: FakeAdapter) => ({
  db,
  bucket: env.OUTPUTS,
  models,
  adapters: { yir: adapter },
  fetcher: outputFetcher,
});

describe('generation jobs', () => {
  it('success: submits with jobId as idempotency key, stores results in R2, no refund', async () => {
    const { userId, jobId } = await paidJob();
    const adapter = new FakeAdapter();
    adapter.polls = [
      { state: 'running' },
      { state: 'succeeded', files: [{ url: 'https://up/x.png', mediaType: 'image/png' }] },
    ];
    await runGeneration(deps(adapter), jobId, immediateSteps());
    expect(adapter.submits[0]).toMatchObject({
      key: jobId,
      input: { upstreamModel: 'vendor/fast', parameters: { aspect_ratio: '1:1' } },
    });
    const job = await loadJob(db, jobId);
    expect(job?.status).toBe('succeeded');
    const [output] = JSON.parse(job!.outputsJson!);
    expect(output).toEqual({ key: `jobs/${jobId}/0.png`, mediaType: 'image/png' });
    expect(await env.OUTPUTS.get(output.key)).not.toBeNull();
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  it('emails signed-in users a direct result link on success; not for guest jobs', async () => {
    const { userId, jobId } = await paidJob();
    await db.insert(user).values({ id: userId, name: 'U', email: `${userId}@example.com` });
    const sent: { to: string; subject: string; text: string }[] = [];
    const email = {
      send: async (message: { to: string; subject: string; text: string }) => {
        sent.push(message);
        return { messageId: 'm1' };
      },
    } as unknown as SendEmail;
    const notify = emailOnSuccess({
      db,
      email,
      from: 'noreply@example.com',
      site: { name: 'Demo' },
      baseURL: 'https://demo.test',
    });
    const adapter = new FakeAdapter();
    adapter.polls = [{ state: 'succeeded', files: [{ url: 'https://up/x.png', mediaType: 'image/png' }] }];
    await runGeneration({ ...deps(adapter), notify }, jobId, immediateSteps());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: `${userId}@example.com`, subject: 'Your Demo image is ready' });
    expect(sent[0]!.text).toContain(`https://demo.test/files/jobs/${jobId}/0.png`);

    await notify({ ...(await loadJob(db, jobId))!, userId: null });
    expect(sent).toHaveLength(1);
  });

  it('notification failure does not affect the job; failed jobs are not notified', async () => {
    const { jobId } = await paidJob();
    const adapter = new FakeAdapter();
    adapter.polls = [{ state: 'succeeded', files: [{ url: 'https://up/x.png', mediaType: 'image/png' }] }];
    const steps: string[] = [];
    await runGeneration(
      {
        ...deps(adapter),
        notify: async () => {
          throw new Error('smtp down');
        },
      },
      jobId,
      immediateSteps(steps),
    );
    expect(steps).toContain('notify');
    expect(steps).not.toContain('abort');
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');

    const failed = await paidJob();
    const rejecting = new FakeAdapter();
    rejecting.polls = [{ state: 'failed', code: 'X', message: 'nope' }];
    let calls = 0;
    await runGeneration(
      {
        ...deps(rejecting),
        notify: async () => {
          calls++;
        },
      },
      failed.jobId,
      immediateSteps(),
    );
    expect(calls).toBe(0);
  });

  it('upstream fails: marked failed and refunded, repeated settlement refunds once', async () => {
    const { userId, jobId } = await paidJob();
    const adapter = new FakeAdapter();
    adapter.polls = [{ state: 'failed', code: 'YIR_CONTENT_REJECTED', message: 'nope' }];
    await runGeneration(deps(adapter), jobId, immediateSteps());
    await markFailed(db, jobId, 'failed', 'again', 'again');
    expect((await loadJob(db, jobId))?.errorCode).toBe('YIR_CONTENT_REJECTED');
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('submit rejected (non-retryable): fails and refunds directly, no polling', async () => {
    const { userId, jobId } = await paidJob();
    const adapter = new FakeAdapter();
    adapter.submitError = new UpstreamError('YIR_INVALID_REQUEST', 'bad', false);
    const steps: string[] = [];
    await runGeneration(deps(adapter), jobId, immediateSteps(steps));
    expect(steps.some((name) => name.startsWith('poll'))).toBe(false);
    expect((await loadJob(db, jobId))?.status).toBe('failed');
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('still failing after retries: fallback marks failed and refunds', async () => {
    const { userId, jobId } = await paidJob();
    const adapter = new FakeAdapter();
    adapter.submitError = new UpstreamError('YIR_TEMPORARILY_UNAVAILABLE', 'busy', true);
    await runGeneration(deps(adapter), jobId, immediateSteps());
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'internal_error' });
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('timeout: cancels the upstream task and refunds', async () => {
    const { userId, jobId } = await paidJob(10, { createdAt: Date.now() - 11 * 60_000 });
    const adapter = new FakeAdapter();
    await runGeneration(deps(adapter), jobId, immediateSteps());
    const job = await loadJob(db, jobId);
    expect(job).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect(adapter.cancelled).toEqual([`up_${jobId}`]);
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('Workflow stops polling after user cancel; succeeded jobs are never changed to failed', async () => {
    const { userId, jobId } = await paidJob();
    await markFailed(db, jobId, 'canceled', 'canceled', 'by user');
    const adapter = new FakeAdapter();
    await runGeneration(deps(adapter), jobId, immediateSteps());
    expect(adapter.submits).toHaveLength(0);
    expect((await getBalance(db, userId)).available).toBe(50);

    const second = await paidJob();
    await markSucceeded(db, second.jobId, []);
    await markFailed(db, second.jobId, 'canceled', 'canceled', 'late cancel');
    expect((await loadJob(db, second.jobId))?.status).toBe('succeeded');
    expect((await getBalance(db, second.userId)).available).toBe(40);
  });

  it('failed guest job returns quota, only once', async () => {
    const rule = { key: `guest:device:${crypto.randomUUID()}`, window: 'w', limit: 1 };
    expect(await consumeQuota(db, [rule])).toBe(true);
    const jobId = `job_${crypto.randomUUID().replaceAll('-', '')}`;
    await db.insert(jobs).values({
      id: jobId,
      guestId: 'g_1',
      modelId: 'fast',
      kind: 'image',
      prompt: 'x',
      inputJson: JSON.stringify({ references: [], parameters: {} }),
      quotaJson: JSON.stringify([rule]),
      upstream: 'yir',
    });
    await markFailed(db, jobId, 'failed', 'x', 'x');
    await markFailed(db, jobId, 'failed', 'x', 'x');
    expect(await consumeQuota(db, [rule])).toBe(true);
    expect(await consumeQuota(db, [rule])).toBe(false);
  });

  it('canceled guest job keeps its quota spent, so create → cancel cannot loop past the daily limit', async () => {
    const rule = { key: `guest:device:${crypto.randomUUID()}`, window: 'w', limit: 1 };
    expect(await consumeQuota(db, [rule])).toBe(true);
    const jobId = `job_${crypto.randomUUID().replaceAll('-', '')}`;
    await db.insert(jobs).values({
      id: jobId,
      guestId: 'g_1',
      modelId: 'fast',
      kind: 'image',
      prompt: 'x',
      inputJson: JSON.stringify({ references: [], parameters: {} }),
      quotaJson: JSON.stringify([rule]),
      upstream: 'yir',
    });
    await markFailed(db, jobId, 'canceled', 'canceled', 'by user');
    expect(await consumeQuota(db, [rule])).toBe(false);
  });
});

describe('old Workflow replay', () => {
  it('old cached load without parts continues as single-part with unchanged step names and idempotency keys', async () => {
    const { jobId } = await paidJob();
    const job = (await loadJob(db, jobId))!;
    const cache = new Map<string, unknown>([
      ['load', { upstream: 'yir', timeoutMinutes: 10, createdAt: job.createdAt }],
    ]);
    const names: string[] = [];
    const steps: StepRunner = {
      async do(name, fn) {
        names.push(name);
        if (cache.has(name)) return cache.get(name) as never;
        const value = await fn();
        cache.set(name, value);
        return value;
      },
      async sleep(name) {
        names.push(name);
      },
    };
    const adapter = new FakeAdapter();
    adapter.polls = [{ state: 'succeeded', files: [{ url: 'https://up/x.png', mediaType: 'image/png' }] }];
    await runGeneration(deps(adapter), jobId, steps);
    expect(adapter.submits.map((s) => s.key)).toEqual([jobId]);
    expect(names).toEqual(['load', 'submit', 'poll:0', 'store', 'finish', 'settle']);
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
  });
});

describe('settlement catch-up', () => {
  it('job marked failed but refund not written: the final Workflow settle step completes the refund', async () => {
    const { userId, jobId } = await paidJob();
    // Simulate the intermediate state "status written as failed, then the refund write failed".
    await db.update(jobs).set({ status: 'failed', errorCode: 'x' }).where(eq(jobs.id, jobId));
    expect((await getBalance(db, userId)).available).toBe(40);
    const steps: string[] = [];
    await runGeneration(deps(new FakeAdapter()), jobId, immediateSteps(steps));
    expect(steps.at(-1)).toBe('settle');
    expect((await getBalance(db, userId)).available).toBe(50);
  });
});

describe('Yir not configured', () => {
  it('missing API key fails as non-retryable with a refund, job never hangs', async () => {
    const { userId, jobId } = await paidJob();
    const adapter = new YirAdapter({ apiKey: '' });
    await runGeneration({ ...deps(new FakeAdapter()), adapters: { yir: adapter } }, jobId, immediateSteps());
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'yir_not_configured' });
    expect((await getBalance(db, userId)).available).toBe(50);
  });
});

describe('Yir request', () => {
  it('uses text input without reference images, image input with them, includes the cost cap', () => {
    const base = { upstreamModel: 'm', kind: 'image' as const, prompt: 'p', parameters: { n: 1 } };
    expect(buildYirRequest({ ...base, references: [] })).toEqual({
      model: 'm',
      parameters: { n: 1 },
      input: { type: 'text', prompt: 'p' },
    });
    expect(
      buildYirRequest({
        ...base,
        references: [{ url: 'https://x/a.png', role: 'reference_image' }],
        maxCost: '0.2',
      }),
    ).toEqual({
      model: 'm',
      parameters: { n: 1 },
      max_cost: '0.2',
      input: {
        type: 'image',
        prompt: 'p',
        references: [{ role: 'reference_image', url: 'https://x/a.png' }],
      },
    });
  });
});

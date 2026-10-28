import { env } from 'cloudflare:test';
import { getBalance, grantCredits, spendCredits } from '@shipwords/core/credits/ledger';
import { createDb } from '@shipwords/core/db/client';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { ComposeInput, Composer, FacesInput } from '../src/compose';
import { appendUpstreamJob, loadJob, markFailed, spendKey } from '../src/lifecycle';
import { defineModels, effectParts, type ModelDefinition } from '../src/models';
import { runGeneration, type StepRunner } from '../src/runner';
import { jobs } from '../src/schema';
import { type PollResult, type SubmitInput, type UpstreamAdapter, UpstreamError } from '../src/upstream';
import { buildYirRequest } from '../src/yir';

const db = createDb(env.DB);

const effectModel: ModelDefinition = {
  id: 'demo',
  name: 'Demo',
  kind: 'video',
  upstream: 'yir',
  upstreamModel: 'vendor/edit',
  credits: 10,
  guest: false,
  allowedParameters: [],
  maxReferences: 0,
  maxCost: '0.80',
  timeoutMinutes: 20,
  effect: {
    slots: [
      { id: 'left', label: 'Left', required: true },
      { id: 'right', label: 'Right', required: false },
    ],
    segments: [
      {
        id: 'left',
        referenceVideo: 'assets/demo/left.mp4',
        slots: ['left'],
        prompt: (images) => `swap in ${images.left}`,
        parameters: { duration: 6 },
        maxCost: '0.30',
      },
      {
        id: 'right',
        referenceVideo: 'https://cdn.example/right.mp4',
        slots: ['right'],
        prompt: (images) => `right ${images.right}`,
        parameters: { duration: 4 },
        maxCost: '0.20',
      },
      {
        id: 'group',
        referenceVideo: 'assets/demo/group.mp4',
        slots: ['left', 'right'],
        prompt: (images) => `group ${images.left} ${images.right ?? '-'}`,
        parameters: { duration: 5 },
        maxCost: '0.30',
      },
    ],
  },
};
const models = defineModels([effectModel]);

const upload = (ref: unknown) =>
  typeof ref === 'string' && ref.startsWith('/files/uploads/') ? `https://site${ref}` : null;
const asset = (key: string) => `https://site/files/${key}`;

describe('effect slot resolution', () => {
  it('renders only segments with filled slots, numbers prompt images by in-segment order, reference video uses reference_video', () => {
    const parts = effectParts(effectModel, { left: '/files/uploads/up_a.png' }, upload, asset)!;
    expect(parts.map((p) => p.id)).toEqual(['left', 'group']);
    expect(parts[0]).toEqual({
      id: 'left',
      upstreamModel: 'vendor/edit',
      prompt: 'swap in @image1',
      references: [
        { url: 'https://site/files/assets/demo/left.mp4', role: 'reference_video' },
        { url: 'https://site/files/uploads/up_a.png', role: 'reference_image' },
      ],
      parameters: { duration: 6 },
      maxCost: '0.30',
      slots: ['left'],
    });
    expect(parts[1]!.prompt).toBe('group @image1 -');
    expect(parts[1]!.slots).toEqual(['left']);

    const both = effectParts(
      effectModel,
      { right: '/files/uploads/up_b.png', left: '/files/uploads/up_a.png' },
      upload,
      asset,
    )!;
    expect(both.map((p) => p.id)).toEqual(['left', 'right', 'group']);
    expect(both[1]!.references[0]!.url).toBe('https://cdn.example/right.mp4');
    // In-segment order comes from the preset, not the order the user sent.
    expect(both[2]!.prompt).toBe('group @image1 @image2');
    expect(both[2]!.references.slice(1).map((r) => r.url)).toEqual([
      'https://site/files/uploads/up_a.png',
      'https://site/files/uploads/up_b.png',
    ]);
  });

  it('with all slots optional any combination works: renders segments containing uploaded slots, rejects when none uploaded', () => {
    const open: ModelDefinition = {
      ...effectModel,
      effect: {
        ...effectModel.effect!,
        slots: effectModel.effect!.slots.map((slot) => ({ ...slot, required: false })),
      },
    };
    expect(defineModels([open])).toHaveLength(1);
    const ids = (slots: Record<string, string>) => effectParts(open, slots, upload, asset)?.map((p) => p.id);
    // Swap a slot that appears in a single segment only.
    expect(ids({ right: '/files/uploads/up_b.png' })).toEqual(['right', 'group']);
    // Cross-segment slot: left appears in both left and group.
    expect(ids({ left: '/files/uploads/up_a.png' })).toEqual(['left', 'group']);
    // Swap all.
    expect(ids({ left: '/files/uploads/up_a.png', right: '/files/uploads/up_b.png' })).toEqual([
      'left',
      'right',
      'group',
    ]);
    expect(effectParts(open, {}, upload, asset)).toBeNull();
  });

  it('rejects missing required, unknown slots, external links and non-objects', () => {
    expect(effectParts(effectModel, { right: '/files/uploads/up_b.png' }, upload, asset)).toBeNull();
    expect(
      effectParts(
        effectModel,
        { left: '/files/uploads/up_a.png', extra: '/files/uploads/up_c.png' },
        upload,
        asset,
      ),
    ).toBeNull();
    expect(effectParts(effectModel, { left: 'https://evil/x.png' }, upload, asset)).toBeNull();
    expect(effectParts(effectModel, ['/files/uploads/up_a.png'], upload, asset)).toBeNull();
    expect(effectParts(effectModel, undefined, upload, asset)).toBeNull();
    expect(
      effectParts({ ...effectModel, effect: undefined }, { left: '/files/uploads/up_a.png' }, upload, asset),
    ).toBeNull();
  });

  it('preset config errors are reported at defineModels time', () => {
    const bad = (effect: ModelDefinition['effect']) => () => defineModels([{ ...effectModel, effect }]);
    const slots = effectModel.effect!.slots;
    const segment = effectModel.effect!.segments[0]!;
    expect(bad({ slots, segments: [{ ...segment, slots: ['extra'] }] })).toThrow(/unknown slot/);
    expect(bad({ slots, segments: [segment] })).toThrow(/slot right is in no segment/);
    expect(bad({ slots: [slots[0]!], segments: [{ ...segment, referenceVideo: 'http://x/a.mp4' }] })).toThrow(
      /referenceVideo/,
    );
    // Whole-job cap: reject when the sum of segment caps (0.30 + 0.20 + 0.30 = 0.80) exceeds the model cap.
    expect(() => defineModels([{ ...effectModel, maxCost: '0.79' }])).toThrow(/exceeds model maxCost/);
    expect(() => defineModels([{ ...effectModel, maxCost: undefined }])).toThrow(/exceeds model maxCost/);
    expect(bad({ slots: [slots[0]!], segments: [{ ...segment, maxCost: '0' }] })).toThrow(/positive maxCost/);
    expect(
      bad({ slots: [slots[0]!], segments: [{ ...segment, referenceVideo: 'assets/../x.mp4' }] }),
    ).toThrow(/referenceVideo/);
  });

  it('reference video picked by the filled slots: every combination is validated up front, parts use the variant for what was filled', () => {
    const group = effectModel.effect!.segments[2]!;
    const masked = (filled: readonly string[]) => `assets/demo/group-${filled.join('-')}.mp4`;
    const variant: ModelDefinition = {
      ...effectModel,
      effect: {
        ...effectModel.effect!,
        segments: effectModel.effect!.segments.map((s) =>
          s.id === 'group' ? { ...group, referenceVideo: masked } : s,
        ),
      },
    };
    expect(defineModels([variant])).toHaveLength(1);
    const video = (slots: Record<string, string>) =>
      effectParts(variant, slots, upload, asset)!.find((p) => p.id === 'group')!.references[0]!.url;
    expect(video({ left: '/files/uploads/up_a.png' })).toBe('https://site/files/assets/demo/group-left.mp4');
    expect(video({ right: '/files/uploads/up_b.png', left: '/files/uploads/up_a.png' })).toBe(
      'https://site/files/assets/demo/group-left-right.mp4',
    );
    // A combination that maps to a bad key (here only right alone) fails at startup, not on a paid job.
    const broken = (filled: readonly string[]) =>
      filled.join() === 'right' ? 'assets/../x.mp4' : masked(filled);
    expect(() =>
      defineModels([
        {
          ...variant,
          effect: {
            ...variant.effect!,
            segments: variant.effect!.segments.map((s) =>
              s.id === 'group' ? { ...s, referenceVideo: broken } : s,
            ),
          },
        },
      ]),
    ).toThrow(/referenceVideo/);
  });
});

describe('Yir request input mode', () => {
  const base = { upstreamModel: 'm', prompt: 'p', parameters: {} };
  it('video with reference video or image uses reference, first frame only uses image, image tasks stay image', () => {
    const reference = buildYirRequest({
      ...base,
      kind: 'video',
      references: [
        { url: 'https://x/v.mp4', role: 'reference_video' },
        { url: 'https://x/a.png', role: 'reference_image' },
      ],
    });
    expect(reference.input.type).toBe('reference');
    const firstFrame = buildYirRequest({
      ...base,
      kind: 'video',
      references: [{ url: 'https://x/a.png', role: 'first_frame' }],
    });
    expect(firstFrame.input.type).toBe('image');
    const image = buildYirRequest({
      ...base,
      kind: 'image',
      references: [{ url: 'https://x/a.png', role: 'reference_image' }],
    });
    expect(image.input.type).toBe('image');
  });
});

class FakeAdapter implements UpstreamAdapter {
  readonly name = 'yir';
  submits: { input: SubmitInput; key: string }[] = [];
  polls = new Map<string, PollResult[]>();
  cancelled: string[] = [];
  /** Errors injected by submit order. */
  submitErrors: (Error | null)[] = [];
  onSubmit: ((key: string) => Promise<void>) | null = null;
  async submit(input: SubmitInput, key: string) {
    const error = this.submitErrors.shift();
    if (error) throw error;
    this.submits.push({ input, key });
    await this.onSubmit?.(key);
    return { upstreamJobId: `up_${key}` };
  }
  async poll(id: string) {
    return this.polls.get(id)?.shift() ?? { state: 'running' as const };
  }
  async cancel(id: string) {
    this.cancelled.push(id);
  }
}

/** Simulated Workflow: successful step results are cached and not re-run on replay. */
function durableSteps(cache = new Map<string, unknown>(), names: string[] = []): StepRunner {
  return {
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
}

const outputFetcher: typeof fetch = async () =>
  new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } });

async function effectJob(slots: Record<string, string>, overrides: Partial<typeof jobs.$inferInsert> = {}) {
  const userId = `u_${crypto.randomUUID().slice(0, 10)}`;
  const jobId = `job_${crypto.randomUUID().replaceAll('-', '')}`;
  const parts = effectParts(effectModel, slots, upload, asset)!;
  await grantCredits(db, { userId, amount: 50, idemKey: `g:${userId}`, source: 'test' });
  await spendCredits(db, { userId, amount: 10, idemKey: spendKey(jobId) }, [
    db.insert(jobs).values({
      id: jobId,
      userId,
      modelId: 'demo',
      kind: 'video',
      prompt: '',
      inputJson: JSON.stringify({ parts }),
      costCredits: 10,
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
const succeeded = (name: string): PollResult => ({
  state: 'succeeded',
  files: [{ url: `https://up/${name}.mp4`, mediaType: 'video/mp4' }],
});

describe('multi-part effect jobs', () => {
  it('success: each segment submits with jobId:segment ID, outputs numbered by segment, charged once', async () => {
    const { userId, jobId } = await effectJob({
      left: '/files/uploads/up_a.png',
      right: '/files/uploads/up_b.png',
    });
    const adapter = new FakeAdapter();
    adapter.polls.set(`up_${jobId}:left`, [{ state: 'running' }, succeeded('left')]);
    adapter.polls.set(`up_${jobId}:right`, [succeeded('right')]);
    adapter.polls.set(`up_${jobId}:group`, [succeeded('group')]);
    await runGeneration(deps(adapter), jobId, durableSteps());

    expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:left`, `${jobId}:right`, `${jobId}:group`]);
    expect(adapter.submits[0]!.input).toMatchObject({
      kind: 'video',
      prompt: 'swap in @image1',
      maxCost: '0.30',
    });
    expect(adapter.submits[1]!.input.maxCost).toBe('0.20');
    const job = await loadJob(db, jobId);
    expect(job?.status).toBe('succeeded');
    expect(job?.upstreamJobId).toBe(`up_${jobId}:left,up_${jobId}:right,up_${jobId}:group`);
    expect(JSON.parse(job!.outputsJson!).map((o: { key: string }) => o.key)).toEqual([
      `jobs/${jobId}/0.mp4`,
      `jobs/${jobId}/1.mp4`,
      `jobs/${jobId}/2.mp4`,
    ]);
    expect(adapter.cancelled).toEqual([]);
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  it('one segment fails: whole job fails, full refund, submitted segments canceled', async () => {
    const { userId, jobId } = await effectJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.polls.set(`up_${jobId}:left`, [succeeded('left')]);
    adapter.polls.set(`up_${jobId}:group`, [
      { state: 'failed', code: 'YIR_CONTENT_REJECTED', message: 'no' },
    ]);
    await runGeneration(deps(adapter), jobId, durableSteps());
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'YIR_CONTENT_REJECTED' });
    expect(adapter.cancelled.sort()).toEqual([`up_${jobId}:group`, `up_${jobId}:left`]);
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('second segment submit rejected (non-retryable): cancels first segment and refunds', async () => {
    const { userId, jobId } = await effectJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.submitErrors = [null, new UpstreamError('YIR_INPUT_REJECTED', 'bad video', false)];
    const names: string[] = [];
    await runGeneration(deps(adapter), jobId, durableSteps(new Map(), names));
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'YIR_INPUT_REJECTED' });
    expect(adapter.cancelled).toEqual([`up_${jobId}:left`]);
    expect(names.some((n) => n.startsWith('poll'))).toBe(false);
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('second segment submit exhausts retries: fallback failure cancels the submitted first segment, refunds once', async () => {
    const { userId, jobId } = await effectJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.submitErrors = [null, new UpstreamError('YIR_TEMPORARILY_UNAVAILABLE', 'busy', true)];
    const names: string[] = [];
    await runGeneration(deps(adapter), jobId, durableSteps(new Map(), names));
    expect(names).toContain('abort');
    expect(adapter.cancelled).toEqual([`up_${jobId}:left`]);
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'internal_error' });
    await markFailed(db, jobId, 'failed', 'again', 'again');
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('replay after interruption: recorded segments are not resubmitted, continues with the next', async () => {
    const { jobId } = await effectJob({ left: '/files/uploads/up_a.png' });
    // The previous run was interrupted after submitting the first segment (Workflow step cache lost, but the DB recorded segment one).
    await appendUpstreamJob(db, jobId, 0, `up_${jobId}:left`);
    const adapter = new FakeAdapter();
    adapter.polls.set(`up_${jobId}:left`, [succeeded('left')]);
    adapter.polls.set(`up_${jobId}:group`, [succeeded('group')]);
    await runGeneration(deps(adapter), jobId, durableSteps());
    expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:group`]);
    expect(await loadJob(db, jobId)).toMatchObject({
      status: 'succeeded',
      upstreamJobId: `up_${jobId}:left,up_${jobId}:group`,
    });
  });

  it('user cancels during submit: the just-submitted segment is canceled, polling stops, refunded', async () => {
    const { userId, jobId } = await effectJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.onSubmit = async (key) => {
      if (key.endsWith(':group')) await markFailed(db, jobId, 'canceled', 'canceled', 'by user');
    };
    const names: string[] = [];
    await runGeneration(deps(adapter), jobId, durableSteps(new Map(), names));
    expect(adapter.cancelled).toContain(`up_${jobId}:group`);
    expect(names.some((n) => n.startsWith('poll'))).toBe(false);
    expect((await loadJob(db, jobId))?.status).toBe('canceled');
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('timeout: past the deadline later segments are not submitted, submitted ones are canceled and refunded', async () => {
    const { userId, jobId } = await effectJob(
      { left: '/files/uploads/up_a.png' },
      { createdAt: Date.now() - 21 * 60_000 },
    );
    const adapter = new FakeAdapter();
    await runGeneration(deps(adapter), jobId, durableSteps());
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:left`]);
    expect(adapter.cancelled).toEqual([`up_${jobId}:left`]);
    expect((await getBalance(db, userId)).available).toBe(50);
  });
});

describe('appendUpstreamJob', () => {
  it('appends in order, repeated calls are idempotent, rejects misordered or ended jobs', async () => {
    const { jobId } = await effectJob({ left: '/files/uploads/up_a.png' });
    expect(await appendUpstreamJob(db, jobId, 1, 'b')).toBe(false);
    expect(await appendUpstreamJob(db, jobId, 0, 'a')).toBe(true);
    expect(await appendUpstreamJob(db, jobId, 0, 'a')).toBe(true);
    expect(await appendUpstreamJob(db, jobId, 0, 'x')).toBe(false);
    expect(await appendUpstreamJob(db, jobId, 2, 'c')).toBe(false);
    expect(await appendUpstreamJob(db, jobId, 1, 'b')).toBe(true);
    expect(await appendUpstreamJob(db, jobId, 1, 'b')).toBe(true);
    expect((await loadJob(db, jobId))?.upstreamJobId).toBe('a,b');
    await markFailed(db, jobId, 'canceled', 'canceled', 'by user');
    expect(await appendUpstreamJob(db, jobId, 2, 'c')).toBe(false);
  });
});

describe('effect compose', () => {
  const composeModel: ModelDefinition = {
    ...effectModel,
    id: 'demo-compose',
    effect: {
      ...effectModel.effect!,
      segments: effectModel.effect!.segments.map((segment, i) => ({
        ...segment,
        target: [5.333, 3.375, 2.688][i]!,
        base: `assets/demo/base-${segment.id}.mp4`,
        ...(segment.id === 'left' ? { fit: 'trim' as const } : {}),
      })),
      compose: {
        audio: 'assets/demo/song.m4a',
        audioStart: 1.375,
        audioDuration: 11.396,
        width: 720,
        height: 1280,
        fps: 24,
      },
    },
  };
  const composeModels = defineModels([composeModel]);

  class FakeComposer implements Composer {
    calls: ComposeInput[] = [];
    error: Error | null = null;
    checks: FacesInput[] = [];
    /** Per-slot similarity returned by each check in turn; returns "swapped" once exhausted. */
    scores: number[][] = [];
    checkError: Error | null = null;
    async compose(input: ComposeInput) {
      this.calls.push(input);
      if (this.error) throw this.error;
      return { song: new Uint8Array([1]).buffer, silent: new Uint8Array([2]).buffer };
    }
    async faces(input: FacesInput) {
      this.checks.push(input);
      if (this.checkError) throw this.checkError;
      return this.scores.shift() ?? input.points.map(() => 0.3);
    }
  }

  async function composeJob(slots: Record<string, string>) {
    const job = await effectJob(slots);
    await db.update(jobs).set({ modelId: 'demo-compose' }).where(eq(jobs.id, job.jobId));
    return job;
  }

  function adapterFor(jobId: string) {
    const adapter = new FakeAdapter();
    for (const part of ['left', 'right', 'group'])
      adapter.polls.set(`up_${jobId}:${part}`, [succeeded(part)]);
    return adapter;
  }

  it('rendered segments use model outputs, unrendered ones use base clips, output keeps only with-track and silent versions', async () => {
    const { userId, jobId } = await composeJob({ left: '/files/uploads/up_a.png' });
    const composer = new FakeComposer();
    await runGeneration(
      { ...deps(adapterFor(jobId)), models: composeModels, composer },
      jobId,
      durableSteps(),
    );
    expect(composer.calls).toHaveLength(1);
    expect(composer.calls[0]).toMatchObject({
      jobId,
      segments: [
        { key: `jobs/${jobId}/0.mp4`, target: 5.333, fit: 'trim' },
        { key: 'assets/demo/base-right.mp4', target: 3.375, fit: 'stretch' },
        { key: `jobs/${jobId}/1.mp4`, target: 2.688, fit: 'stretch' },
      ],
      audio: { key: 'assets/demo/song.m4a', start: 1.375, duration: 11.396 },
    });
    const job = await loadJob(db, jobId);
    expect(job?.status).toBe('succeeded');
    expect(JSON.parse(job!.outputsJson!)).toEqual([
      { key: `jobs/${jobId}/2.mp4`, mediaType: 'video/mp4' },
      { key: `jobs/${jobId}/3.mp4`, mediaType: 'video/mp4' },
    ]);
    expect(new Uint8Array(await (await env.OUTPUTS.get(`jobs/${jobId}/3.mp4`))!.arrayBuffer())).toEqual(
      new Uint8Array([2]),
    );
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  it('compose fails (retries exhausted): whole job fails, full refund, refunded once', async () => {
    const { userId, jobId } = await composeJob({ left: '/files/uploads/up_a.png' });
    const composer = new FakeComposer();
    composer.error = new Error('ffmpeg exploded');
    await runGeneration(
      { ...deps(adapterFor(jobId)), models: composeModels, composer },
      jobId,
      durableSteps(),
    );
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'internal_error' });
    await markFailed(db, jobId, 'failed', 'again', 'again');
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('site has no compose container bound: fails with refund, never delivers a partial result', async () => {
    const { userId, jobId } = await composeJob({ left: '/files/uploads/up_a.png' });
    await runGeneration({ ...deps(adapterFor(jobId)), models: composeModels }, jobId, durableSteps());
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed' });
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('replay after interruption before compose: segments not resubmitted, compose writes the same keys', async () => {
    const { jobId } = await composeJob({ left: '/files/uploads/up_a.png' });
    const adapter = adapterFor(jobId);
    const cache = new Map<string, unknown>();
    const composer = new FakeComposer();
    composer.error = new Error('container cold');
    // First run: compose throws. Simulate a Workflow retry: keep cached successful steps, drop the fallback's steps, run again.
    const crashing: StepRunner = {
      async do(name, fn) {
        if (name === 'abort' || name === 'settle') throw new Error('stop here');
        if (cache.has(name)) return cache.get(name) as never;
        const value = await fn();
        cache.set(name, value);
        return value;
      },
      async sleep() {},
    };
    await expect(
      runGeneration({ ...deps(adapter), models: composeModels, composer }, jobId, crashing),
    ).rejects.toThrow();
    composer.error = null;
    await runGeneration({ ...deps(adapter), models: composeModels, composer }, jobId, durableSteps(cache));
    expect(adapter.submits).toHaveLength(2);
    expect(composer.calls).toHaveLength(2);
    expect(JSON.parse((await loadJob(db, jobId))!.outputsJson!).map((o: { key: string }) => o.key)).toEqual([
      `jobs/${jobId}/2.mp4`,
      `jobs/${jobId}/3.mp4`,
    ]);
  });

  it('incomplete compose config errors at defineModels time', () => {
    const segments = composeModel.effect!.segments;
    expect(() =>
      defineModels([
        {
          ...composeModel,
          effect: {
            ...composeModel.effect!,
            segments: [{ ...segments[0]!, base: undefined }, ...segments.slice(1)],
          },
        },
      ]),
    ).toThrow(/needs target/);
    expect(() =>
      defineModels([
        {
          ...composeModel,
          effect: {
            ...composeModel.effect!,
            compose: { ...composeModel.effect!.compose!, audio: 'https://x/a.m4a' },
          },
        },
      ]),
    ).toThrow(/compose.audio/);
  });

  describe('output check', () => {
    const leftCheck = {
      original: 'assets/demo/base-left.mp4',
      faces: { left: [0.5, 0.4] as const },
      maxSimilarity: 0.6,
      retries: 1,
    };
    const groupCheck = {
      original: 'assets/demo/base-group.mp4',
      faces: { left: [0.3, 0.5] as const, right: [0.7, 0.5] as const },
      maxSimilarity: 0.6,
      retries: 0,
    };
    const checkModel: ModelDefinition = {
      ...composeModel,
      id: 'demo-check',
      // The left segment runs at most twice: 0.30 × 2 + 0.20 + 0.30.
      maxCost: '1.10',
      effect: {
        ...composeModel.effect!,
        segments: composeModel.effect!.segments.map((segment) =>
          segment.id === 'left'
            ? { ...segment, check: leftCheck }
            : segment.id === 'group'
              ? { ...segment, check: groupCheck }
              : segment,
        ),
      },
    };
    const checkModels = defineModels([checkModel]);
    const checkDeps = (adapter: FakeAdapter, composer: FakeComposer) => ({
      ...deps(adapter),
      models: checkModels,
      composer,
    });
    const retryKey = (jobId: string) => `${jobId}:left:retry1`;

    async function checkJob() {
      const job = await effectJob({ left: '/files/uploads/up_a.png' });
      await db.update(jobs).set({ modelId: 'demo-check' }).where(eq(jobs.id, job.jobId));
      return job;
    }

    it('swapped: checks each segment once, only the filled slots, trim over the raw target, stretch over the model duration', async () => {
      const { userId, jobId } = await checkJob();
      const adapter = adapterFor(jobId);
      const composer = new FakeComposer();
      composer.scores = [[0.32]];
      await runGeneration(checkDeps(adapter, composer), jobId, durableSteps());
      expect(composer.checks).toEqual([
        {
          jobId,
          key: `jobs/${jobId}/0.mp4`,
          originalKey: 'assets/demo/base-left.mp4',
          points: [[0.5, 0.4]],
          seconds: 5.333,
        },
        // right is not filled, so only the left person in the group shot is checked.
        {
          jobId,
          key: `jobs/${jobId}/1.mp4`,
          originalKey: 'assets/demo/base-group.mp4',
          points: [[0.3, 0.5]],
          seconds: 5,
        },
      ]);
      expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:left`, `${jobId}:group`]);
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
      expect((await getBalance(db, userId)).available).toBe(40);
    });

    it('first run not swapped: reruns once with the same parameters, compose uses the rerun output after the check passes', async () => {
      const { userId, jobId } = await checkJob();
      const adapter = adapterFor(jobId);
      adapter.polls.set(`up_${retryKey(jobId)}`, [{ state: 'running' }, succeeded('left-retry')]);
      const composer = new FakeComposer();
      composer.scores = [
        [0.84, 0.81, 0.6],
        [0.4, 0.38],
      ];
      await runGeneration(checkDeps(adapter, composer), jobId, durableSteps());
      expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:left`, `${jobId}:group`, retryKey(jobId)]);
      expect(adapter.submits[2]!.input).toEqual(adapter.submits[0]!.input);
      expect(composer.checks.map((c) => c.key)).toEqual([
        `jobs/${jobId}/0.mp4`,
        `jobs/${jobId}/1.mp4`,
        `jobs/${jobId}/2.mp4`,
      ]);
      expect(composer.calls[0]!.segments.map((s) => s.key)).toEqual([
        `jobs/${jobId}/1.mp4`,
        'assets/demo/base-right.mp4',
        `jobs/${jobId}/2.mp4`,
      ]);
      const job = await loadJob(db, jobId);
      expect(job).toMatchObject({ status: 'succeeded' });
      expect(job!.upstreamJobId!.split(',')).toEqual([
        `up_${jobId}:left`,
        `up_${jobId}:group`,
        `up_${retryKey(jobId)}`,
      ]);
      expect((await getBalance(db, userId)).available).toBe(40);
    });

    it('still not swapped after rerun: whole job fails swap_not_applied, cancels running segments, refunds once', async () => {
      const { userId, jobId } = await checkJob();
      const adapter = adapterFor(jobId);
      adapter.polls.set(`up_${jobId}:group`, []);
      adapter.polls.set(`up_${retryKey(jobId)}`, [succeeded('left-retry')]);
      const composer = new FakeComposer();
      composer.scores = [[0.86], [0.8]];
      await runGeneration(checkDeps(adapter, composer), jobId, durableSteps());
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'swap_not_applied' });
      expect(adapter.cancelled).toEqual(
        expect.arrayContaining([`up_${jobId}:group`, `up_${retryKey(jobId)}`]),
      );
      expect(composer.calls).toHaveLength(0);
      await markFailed(db, jobId, 'failed', 'again', 'again');
      expect((await getBalance(db, userId)).available).toBe(50);
    });

    it('check errors: treated as a pass, delivered normally, no rerun, no refund', async () => {
      const { userId, jobId } = await checkJob();
      const adapter = adapterFor(jobId);
      const composer = new FakeComposer();
      composer.checkError = new Error('container cold');
      const log = vi.fn();
      await runGeneration({ ...checkDeps(adapter, composer), log }, jobId, durableSteps());
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
      expect(adapter.submits).toHaveLength(2);
      expect(log).toHaveBeenCalledWith('swap check errored, delivering as is', expect.anything());
      expect((await getBalance(db, userId)).available).toBe(40);
    });

    it('replay after interruption following rerun submit: rerun not resubmitted, check results reused from cache', async () => {
      const { jobId } = await checkJob();
      const adapter = adapterFor(jobId);
      adapter.polls.set(`up_${retryKey(jobId)}`, [succeeded('left-retry')]);
      const composer = new FakeComposer();
      composer.scores = [[0.9]];
      const cache = new Map<string, unknown>();
      const crashing: StepRunner = {
        async do(name, fn) {
          if (name.startsWith('poll:left:retry1') || name === 'abort' || name === 'settle')
            throw new Error('stop here');
          if (cache.has(name)) return cache.get(name) as never;
          const value = await fn();
          cache.set(name, value);
          return value;
        },
        async sleep() {},
      };
      await expect(runGeneration(checkDeps(adapter, composer), jobId, crashing)).rejects.toThrow();
      await runGeneration(checkDeps(adapter, composer), jobId, durableSteps(cache));
      expect(adapter.submits.filter((s) => s.key === retryKey(jobId))).toHaveLength(1);
      // First run: left round 0. Replay: left round 0 from cache, then left round 1 and group.
      expect(composer.checks).toHaveLength(3);
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
    });

    it('user already canceled when rerun is submitted: cancels the new rerun task, stops polling, refunds', async () => {
      const { userId, jobId } = await checkJob();
      const adapter = adapterFor(jobId);
      adapter.onSubmit = async (key) => {
        if (key === retryKey(jobId)) await markFailed(db, jobId, 'canceled', 'canceled', 'user canceled');
      };
      const composer = new FakeComposer();
      composer.scores = [[0.9]];
      await runGeneration(checkDeps(adapter, composer), jobId, durableSteps());
      expect(adapter.cancelled).toContain(`up_${retryKey(jobId)}`);
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'canceled' });
      expect(composer.calls).toHaveLength(0);
      expect((await getBalance(db, userId)).available).toBe(50);
    });

    it('group shot with no retries: an original face still there fails the job right away with a refund', async () => {
      const { userId, jobId } = await checkJob();
      const adapter = adapterFor(jobId);
      const composer = new FakeComposer();
      composer.scores = [[0.3], [0.91]];
      await runGeneration(checkDeps(adapter, composer), jobId, durableSteps());
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'swap_not_applied' });
      expect(adapter.submits).toHaveLength(2);
      expect((await getBalance(db, userId)).available).toBe(50);
    });

    it('jobs stored before parts recorded their slots: nothing is checked, delivered as is', async () => {
      const { jobId } = await checkJob();
      const job = await loadJob(db, jobId);
      const input = JSON.parse(job!.inputJson) as { parts: { slots?: string[] }[] };
      for (const part of input.parts) delete part.slots;
      await db
        .update(jobs)
        .set({ inputJson: JSON.stringify(input) })
        .where(eq(jobs.id, jobId));
      const adapter = adapterFor(jobId);
      const composer = new FakeComposer();
      await runGeneration(checkDeps(adapter, composer), jobId, durableSteps());
      expect(composer.checks).toHaveLength(0);
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
    });

    it('in-flight jobs whose cached load has the old similarity check: delivered without checking', async () => {
      const { jobId } = await checkJob();
      const adapter = adapterFor(jobId);
      const composer = new FakeComposer();
      const steps = durableSteps();
      const replaying: StepRunner = {
        async do(name, fn) {
          const value = await steps.do(name, fn);
          if (name !== 'load' || !value || typeof value !== 'object' || !('checks' in value)) return value;
          // What an older version cached: SSIM settings, no original or faces.
          return {
            ...value,
            checks: {
              left: { maxSimilarity: 0.75, retries: 1, referenceKey: 'assets/demo/left.mp4', seconds: 5.333 },
            },
          } as never;
        },
        sleep: (name, ms) => steps.sleep(name, ms),
      };
      await runGeneration(checkDeps(adapter, composer), jobId, replaying);
      expect(composer.checks).toHaveLength(0);
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
    });

    it('old-format check whose first round already ran and failed: the cached rerun is replayed, output numbering stays the same', async () => {
      const { jobId } = await checkJob();
      const adapter = adapterFor(jobId);
      adapter.polls.set(`up_${retryKey(jobId)}`, [succeeded('left-retry')]);
      const composer = new FakeComposer();
      // What an older version cached: its load with SSIM settings, and a first check round that found the swap missing.
      const cache = new Map<string, unknown>([['check:left:0', { scores: [0.9] }]]);
      const steps = durableSteps(cache);
      const replaying: StepRunner = {
        async do(name, fn) {
          const value = await steps.do(name, fn);
          if (name !== 'load' || !value || typeof value !== 'object' || !('checks' in value)) return value;
          return {
            ...value,
            checks: {
              left: { maxSimilarity: 0.75, retries: 1, referenceKey: 'assets/demo/left.mp4', seconds: 5.333 },
            },
          } as never;
        },
        sleep: (name, ms) => steps.sleep(name, ms),
      };
      await runGeneration(checkDeps(adapter, composer), jobId, replaying);
      expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:left`, `${jobId}:group`, retryKey(jobId)]);
      expect(composer.checks).toHaveLength(0);
      expect(composer.calls[0]!.segments.map((s) => s.key)).toEqual([
        `jobs/${jobId}/1.mp4`,
        'assets/demo/base-right.mp4',
        `jobs/${jobId}/2.mp4`,
      ]);
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
    });

    it("config validation: assets/ original, faces mapping this segment's slots to 0–1 points, bounded threshold and retries, reruns count toward the job cap", () => {
      const withCheck =
        (check: Record<string, unknown>, extra: object = {}) =>
        () =>
          defineModels([
            {
              ...checkModel,
              ...extra,
              effect: {
                ...checkModel.effect!,
                segments: checkModel.effect!.segments.map((s) =>
                  s.id === 'left' ? { ...s, check: { ...leftCheck, ...check } as never } : s,
                ),
              },
            },
          ]);
      expect(withCheck({})).not.toThrow();
      expect(withCheck({ maxSimilarity: 1.2 })).toThrow(/maxSimilarity/);
      expect(withCheck({ retries: 5 }, { maxCost: '5.00' })).toThrow(/retries/);
      expect(withCheck({}, { maxCost: '0.80' })).toThrow(/exceeds/);
      expect(withCheck({ original: 'https://cdn.example/left.mp4' })).toThrow(/check.original/);
      expect(withCheck({ original: 'assets/../secret.mp4' })).toThrow(/check.original/);
      expect(withCheck({ faces: {} })).toThrow(/check.faces/);
      expect(withCheck({ faces: { right: [0.5, 0.5] } })).toThrow(/check.faces/);
      expect(withCheck({ faces: { left: [0.5, 1.5] } })).toThrow(/check.faces/);
      expect(() =>
        defineModels([
          {
            ...effectModel,
            maxCost: '1.10',
            effect: {
              ...effectModel.effect!,
              segments: effectModel.effect!.segments.map((s) =>
                s.id === 'left' ? { ...s, check: leftCheck } : s,
              ),
            },
          },
        ]),
      ).toThrow(/needs compose/);
    });
  });
});

describe('prep and reference audio', () => {
  const prepModel: ModelDefinition = {
    ...effectModel,
    id: 'demo-prep',
    maxCost: '0.84',
    effect: {
      slots: [
        { id: 'left', label: 'Left', required: true, prep: 'left outfit' },
        { id: 'right', label: 'Right', required: false },
      ],
      segments: effectModel.effect!.segments.map((segment) =>
        segment.id === 'group' ? { ...segment, referenceAudio: 'assets/demo/group.mp3' } : segment,
      ),
      prep: { upstreamModel: 'vendor/image', parameters: { resolution: '1K' }, maxCost: '0.04' },
    },
  };
  const prepModels = defineModels([prepModel]);
  const prepDeps = (adapter: FakeAdapter) => ({ ...deps(adapter), models: prepModels });
  const image = (url: string): PollResult => ({
    state: 'succeeded',
    files: [{ url, mediaType: 'image/png' }],
  });

  async function prepJob(slots: Record<string, string>) {
    const userId = `u_${crypto.randomUUID().slice(0, 10)}`;
    const jobId = `job_${crypto.randomUUID().replaceAll('-', '')}`;
    const parts = effectParts(prepModel, slots, upload, asset)!;
    await grantCredits(db, { userId, amount: 50, idemKey: `g:${userId}`, source: 'test' });
    await spendCredits(db, { userId, amount: 10, idemKey: spendKey(jobId) }, [
      db.insert(jobs).values({
        id: jobId,
        userId,
        modelId: 'demo-prep',
        kind: 'video',
        prompt: '',
        inputJson: JSON.stringify({ parts }),
        costCredits: 10,
        upstream: 'yir',
      }),
    ]);
    return { userId, jobId };
  }

  it('resolution: prep segments first, video segments reference prep results via placeholders, slots without prep keep the original, reference audio after reference images', () => {
    const parts = effectParts(
      prepModel,
      { left: '/files/uploads/up_a.png', right: '/files/uploads/up_b.png' },
      upload,
      asset,
    )!;
    expect(parts.map((p) => p.id)).toEqual(['prep-left', 'left', 'right', 'group']);
    expect(parts[0]).toEqual({
      id: 'prep-left',
      kind: 'image',
      upstreamModel: 'vendor/image',
      prompt: 'left outfit',
      references: [{ url: 'https://site/files/uploads/up_a.png', role: 'reference_image' }],
      parameters: { resolution: '1K' },
      maxCost: '0.04',
    });
    expect(parts[3]!.references).toEqual([
      { url: 'https://site/files/assets/demo/group.mp4', role: 'reference_video' },
      { url: 'prep:left', role: 'reference_image' },
      { url: 'https://site/files/uploads/up_b.png', role: 'reference_image' },
      { url: 'https://site/files/assets/demo/group.mp3', role: 'reference_audio' },
    ]);
    // Only a slot without prep is filled: no prep segment.
    const optional: ModelDefinition = {
      ...prepModel,
      effect: {
        ...prepModel.effect!,
        slots: prepModel.effect!.slots.map((slot) => ({ ...slot, required: false })),
      },
    };
    expect(
      effectParts(optional, { right: '/files/uploads/up_b.png' }, upload, asset)!.map((p) => p.id),
    ).toEqual(['right', 'group']);
  });

  it('config validation: prep cost counts toward the job cap, reference audio only accepts assets/*.mp3 or https', () => {
    expect(() => defineModels([{ ...prepModel, maxCost: '0.83' }])).toThrow(/exceeds model maxCost/);
    expect(() =>
      defineModels([
        {
          ...prepModel,
          effect: {
            ...prepModel.effect!,
            segments: prepModel.effect!.segments.map((segment) => ({
              ...segment,
              referenceAudio: 'assets/demo/a.m4a',
            })),
          },
        },
      ]),
    ).toThrow(/referenceAudio/);
  });

  it('execution: video segments submit after prep finishes, placeholders replaced with prep results, prep images not stored, output numbered from 0', async () => {
    const { userId, jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.polls.set(`up_${jobId}:prep-left`, [{ state: 'running' }, image('https://up/left-prep.png')]);
    adapter.polls.set(`up_${jobId}:left`, [succeeded('left')]);
    adapter.polls.set(`up_${jobId}:group`, [succeeded('group')]);
    let videoSubmittedEarly = false;
    adapter.onSubmit = async (key) => {
      if (!key.endsWith('prep-left') && (adapter.polls.get(`up_${jobId}:prep-left`)?.length ?? 0) > 0)
        videoSubmittedEarly = true;
    };
    await runGeneration(prepDeps(adapter), jobId, durableSteps());

    expect(videoSubmittedEarly).toBe(false);
    expect(adapter.submits.map((s) => s.key)).toEqual([
      `${jobId}:prep-left`,
      `${jobId}:left`,
      `${jobId}:group`,
    ]);
    expect(adapter.submits[0]!.input).toMatchObject({
      kind: 'image',
      upstreamModel: 'vendor/image',
      maxCost: '0.04',
    });
    expect(adapter.submits[1]!.input.kind).toBe('video');
    expect(adapter.submits[1]!.input.references[1]).toEqual({
      url: 'https://up/left-prep.png',
      role: 'reference_image',
    });
    const job = await loadJob(db, jobId);
    expect(job).toMatchObject({
      status: 'succeeded',
      upstreamJobId: `up_${jobId}:prep-left,up_${jobId}:left,up_${jobId}:group`,
    });
    expect(JSON.parse(job!.outputsJson!).map((o: { key: string }) => o.key)).toEqual([
      `jobs/${jobId}/0.mp4`,
      `jobs/${jobId}/1.mp4`,
    ]);
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  const finishVideo = (adapter: FakeAdapter, jobId: string) => {
    adapter.polls.set(`up_${jobId}:left`, [succeeded('left')]);
    adapter.polls.set(`up_${jobId}:group`, [succeeded('group')]);
  };

  it('prep fails (e.g. celebrity photo rejected): falls back to the original photo, no refund', async () => {
    const { userId, jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.polls.set(`up_${jobId}:prep-left`, [
      { state: 'failed', code: 'YIR_CONTENT_REJECTED', message: 'no' },
    ]);
    finishVideo(adapter, jobId);
    await runGeneration(prepDeps(adapter), jobId, durableSteps());
    expect(adapter.submits.map((s) => s.key)).toEqual([
      `${jobId}:prep-left`,
      `${jobId}:left`,
      `${jobId}:group`,
    ]);
    expect(adapter.submits[1]!.input.references[1]!.url).toBe('https://site/files/uploads/up_a.png');
    expect(adapter.cancelled).toEqual([]);
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  it('prep succeeds but returns no image: also falls back to the original photo', async () => {
    const { jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.polls.set(`up_${jobId}:prep-left`, [{ state: 'succeeded', files: [] }]);
    finishVideo(adapter, jobId);
    await runGeneration(prepDeps(adapter), jobId, durableSteps());
    expect(adapter.submits[1]!.input.references[1]!.url).toBe('https://site/files/uploads/up_a.png');
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
  });

  it('prep submit rejected outright (non-retryable): records a placeholder, never polls or cancels it, video segment uses the original photo', async () => {
    const { jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.submitErrors = [new UpstreamError('YIR_INPUT_REJECTED', 'public figure', false)];
    finishVideo(adapter, jobId);
    const names: string[] = [];
    await runGeneration(prepDeps(adapter), jobId, durableSteps(new Map(), names));
    expect(names.some((n) => n.startsWith('poll:prep-left'))).toBe(false);
    expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:left`, `${jobId}:group`]);
    expect(adapter.submits[0]!.input.references[1]!.url).toBe('https://site/files/uploads/up_a.png');
    expect(await loadJob(db, jobId)).toMatchObject({
      status: 'succeeded',
      upstreamJobId: `skipped:prep-left,up_${jobId}:left,up_${jobId}:group`,
    });
  });

  it('video segment fails after prep rejection: whole job refunded, placeholder skipped on cancel', async () => {
    const { userId, jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.submitErrors = [new UpstreamError('YIR_INPUT_REJECTED', 'public figure', false)];
    adapter.polls.set(`up_${jobId}:left`, [{ state: 'failed', code: 'YIR_CONTENT_REJECTED', message: 'no' }]);
    await runGeneration(prepDeps(adapter), jobId, durableSteps());
    expect(adapter.cancelled.sort()).toEqual([`up_${jobId}:group`, `up_${jobId}:left`]);
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'YIR_CONTENT_REJECTED' });
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('prep finishes after the deadline: video segments not submitted, prep segment canceled and refunded', async () => {
    const { userId, jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    // The clock passes 21 minutes when the prep poll returns, simulating prep using up the time limit.
    adapter.polls.set(`up_${jobId}:prep-left`, [image('https://up/left-prep.png')]);
    const poll = adapter.poll.bind(adapter);
    const start = Date.now();
    adapter.poll = async (id: string) => {
      const result = await poll(id);
      vi.spyOn(Date, 'now').mockReturnValue(start + 21 * 60_000);
      return result;
    };
    try {
      await runGeneration(prepDeps(adapter), jobId, durableSteps());
    } finally {
      vi.restoreAllMocks();
    }
    expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:prep-left`]);
    expect(adapter.cancelled).toEqual([`up_${jobId}:prep-left`]);
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('replay after interruption during video submit: prep not resubmitted, placeholders still use cached prep results', async () => {
    const { jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.polls.set(`up_${jobId}:prep-left`, [image('https://up/left-prep.png')]);
    adapter.polls.set(`up_${jobId}:left`, [succeeded('left')]);
    adapter.polls.set(`up_${jobId}:group`, [succeeded('group')]);
    adapter.submitErrors = [null, null, new Error('worker evicted')];
    const cache = new Map<string, unknown>();
    // First run: throws on submitting video segment 2, and the fallback step is also interrupted (simulating Worker eviction), so the job stays in progress.
    const crashing = durableSteps(cache);
    await expect(
      runGeneration(prepDeps(adapter), jobId, {
        ...crashing,
        async do(name, fn) {
          if (name === 'abort') throw new Error('interrupted');
          return crashing.do(name, fn);
        },
      }),
    ).rejects.toThrow(/interrupted/);
    // Second run: replay from cache.
    await runGeneration(prepDeps(adapter), jobId, durableSteps(cache));
    expect(adapter.submits.map((s) => s.key)).toEqual([
      `${jobId}:prep-left`,
      `${jobId}:left`,
      `${jobId}:group`,
    ]);
    expect(adapter.submits[2]!.input.references[1]!.url).toBe('https://up/left-prep.png');
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
  });
});

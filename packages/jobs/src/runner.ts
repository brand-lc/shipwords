import type { Db } from '@shipwords/core/db/client';
import type { Composer, ComposeSegment } from './compose';
import {
  appendUpstreamJob,
  loadJob,
  markFailed,
  markSucceeded,
  SKIPPED_UPSTREAM as SKIPPED,
  type StoredOutput,
  settleFailure,
  upstreamIds,
} from './lifecycle';
import { type JobPart, type ModelDefinition, PREP_REF } from './models';
import { type JobRow, TERMINAL } from './schema';
import type { OutputFile, PollResult, SubmitInput, UpstreamAdapter } from './upstream';
import { UpstreamError } from './upstream';

// The full execution of one generation job. The Workflow persists each step's result and resumes after interruption;
// this only depends on the StepRunner interface, so tests pass an implementation that runs directly.

export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export interface RunnerDeps {
  db: Db;
  bucket: R2Bucket;
  models: readonly ModelDefinition[];
  adapters: Record<string, UpstreamAdapter>;
  /** Effect compose (effect.compose); empty when the site binds no container, and jobs that need compose fail with a refund. */
  composer?: Composer;
  fetcher?: typeof fetch;
  /** Notify the user on success (e.g. email) so they don't have to wait on the page; failures are only logged and don't affect the job. */
  notify?: (job: JobRow) => Promise<void>;
  log?: (message: string, details: Record<string, unknown>) => void;
}

const POLL_WAIT_SECONDS = 20;
const POLL_PAUSE_MS = 3_000;
/** Prep images usually finish in about 35 s; one still running past this gets a second copy, and whichever finishes first is used. */
export const PREP_HEDGE_MS = 60_000;

function extensionFor(mediaType: string): string {
  const subtype = mediaType.split('/')[1]?.split(';')[0] ?? 'bin';
  return subtype === 'jpeg' ? 'jpg' : subtype.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
}

/** Upstream result links expire, so copy the files into our own R2 before finishing. */
export async function storeOutputs(
  deps: RunnerDeps,
  jobId: string,
  files: OutputFile[],
  /** Starting index of this segment's outputs in a multi-part job, so keys don't collide. */
  startIndex = 0,
): Promise<StoredOutput[]> {
  const fetcher = deps.fetcher ?? fetch;
  const stored: StoredOutput[] = [];
  for (const [index, file] of files.entries()) {
    const response = await fetcher(file.url);
    if (!response.ok || !response.body)
      throw new Error(`download output ${index} failed: ${response.status}`);
    const mediaType = response.headers.get('content-type') ?? file.mediaType;
    const key = `jobs/${jobId}/${startIndex + index}.${extensionFor(mediaType)}`;
    await deps.bucket.put(key, response.body, { httpMetadata: { contentType: mediaType } });
    stored.push({ key, mediaType });
  }
  return stored;
}

/**
 * Each Workflow step retries on its own; once retries are exhausted step.do throws. This fallback marks the job failed and refunds,
 * otherwise the job would stay in progress forever and the user's credits would never come back.
 */
export async function runGeneration(deps: RunnerDeps, jobId: string, step: StepRunner): Promise<void> {
  try {
    await runSteps(deps, jobId, step);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.('generation aborted', { jobId, error: message });
    await step.do('abort', async () => {
      // In a multi-part job some segments may still be running upstream: after fail + refund nobody needs them, so cancel to avoid wasted charges.
      const job = await loadJob(deps.db, jobId);
      const adapter = job ? deps.adapters[job.upstream] : undefined;
      if (job && adapter && !TERMINAL.includes(job.status)) await cancelAll(adapter, upstreamIds(job));
      await markFailed(deps.db, jobId, 'failed', 'internal_error', message);
      return true;
    });
  }
  // Always settle once at the end: if a step marked the job failed but the refund write failed, on retry that step is skipped because the job is terminal,
  // so settle here on the final state (refunds and quota returns are idempotent).
  await step.do('settle', async () => {
    const job = await loadJob(deps.db, jobId);
    if (job) await settleFailure(deps.db, job);
    return true;
  });
}

interface SegmentCheck {
  maxSimilarity: number;
  retries: number;
  /** Missing on checks cached by older versions (per-second SSIM): those jobs are delivered unchecked. */
  original?: string;
  faces?: Readonly<Record<string, readonly [number, number]>>;
  seconds: number;
}

interface JobInput {
  references?: { url: string; role: string }[];
  parameters?: Record<string, unknown>;
  parts?: JobPart[];
}

export function partsOf(job: { prompt: string; inputJson: string }, model: ModelDefinition): JobPart[] {
  const input = JSON.parse(job.inputJson) as JobInput;
  if (input.parts?.length) return input.parts;
  return [
    {
      id: 'main',
      upstreamModel: model.upstreamModel,
      prompt: job.prompt,
      references: input.references ?? [],
      parameters: input.parameters ?? {},
      ...(model.maxCost ? { maxCost: model.maxCost } : {}),
    },
  ];
}

/**
 * Poll copies of the same request: the first success wins and the other copies are canceled.
 * Running while any copy runs; a query error is thrown only when no copy succeeded or is still running; failed once every copy failed.
 */
async function pollCopies(
  adapter: UpstreamAdapter,
  ids: readonly string[],
  waitSeconds: number,
): Promise<PollResult> {
  type Outcome = { id: string; result: PollResult } | { id: string; error: unknown };
  const outcomes = await new Promise<Outcome[]>((resolve) => {
    const done: Outcome[] = [];
    const settle = (outcome: Outcome) => {
      done.push(outcome);
      if (('result' in outcome && outcome.result.state === 'succeeded') || done.length === ids.length)
        resolve(done);
    };
    for (const id of ids)
      adapter.poll(id, waitSeconds).then(
        (result) => settle({ id, result }),
        (error: unknown) => settle({ id, error }),
      );
  });
  const results = outcomes.flatMap((outcome) => ('result' in outcome ? [outcome] : []));
  const won = results.find(({ result }) => result.state === 'succeeded');
  if (won) {
    await cancelAll(
      adapter,
      ids.filter((id) => id !== won.id),
    );
    return won.result;
  }
  const running = results.find(({ result }) => result.state === 'running');
  if (running) return running.result;
  const errored = outcomes.find((outcome) => 'error' in outcome);
  if (errored && 'error' in errored) throw errored.error;
  return results[0]!.result;
}

async function cancelAll(adapter: UpstreamAdapter, ids: readonly string[]) {
  await Promise.all(
    ids.filter((id) => !id.startsWith(SKIPPED)).map((id) => adapter.cancel(id).catch(() => undefined)),
  );
}

async function runSteps(deps: RunnerDeps, jobId: string, step: StepRunner): Promise<void> {
  const setup = await step.do('load', async () => {
    const job = await loadJob(deps.db, jobId);
    if (!job || TERMINAL.includes(job.status)) return null;
    const model = deps.models.find((m) => m.id === job.modelId);
    if (!model) return { missingModel: job.modelId };
    const parts = partsOf(job, model).map((part) => part.id);
    return {
      upstream: model.upstream,
      timeoutMinutes: model.timeoutMinutes,
      createdAt: job.createdAt,
      parts,
      prep: partsOf(job, model).filter((part) => part.kind === 'image' && model.kind === 'video').length,
      compose: Boolean(model.effect?.compose),
      // Output checks: segment ID → config. Cached loads from older versions lack this, so old in-flight jobs keep running unchecked.
      checks: Object.fromEntries(
        (model.effect?.segments ?? [])
          .filter((segment) => segment.check && parts.includes(segment.id))
          .map((segment) => [
            segment.id,
            {
              maxSimilarity: segment.check!.maxSimilarity,
              retries: segment.check!.retries,
              original: segment.check!.original,
              faces: segment.check!.faces,
              // trim segments only put the first target seconds into the output, not rounded: comparing more would include the next shot that gets cut, less would miss the last frames.
              // stretch segments use the whole clip, so compare over the model duration.
              seconds:
                segment.fit === 'trim'
                  ? segment.target!
                  : Number(segment.parameters.duration) || segment.target!,
            },
          ]),
      ) as Record<string, SegmentCheck>,
    };
  });
  if (!setup) return;
  if ('missingModel' in setup) {
    await step.do('fail:model_removed', async () => {
      await markFailed(
        deps.db,
        jobId,
        'failed',
        'model_removed',
        `model ${setup.missingModel} is no longer configured`,
      );
      return true;
    });
    return;
  }
  const adapter = deps.adapters[setup.upstream];
  if (!adapter) {
    await step.do('fail:upstream_missing', async () => {
      await markFailed(deps.db, jobId, 'failed', 'upstream_missing', `no adapter for ${setup.upstream}`);
      return true;
    });
    return;
  }

  // Single-part jobs keep their original step names and idempotency keys so old in-flight jobs line up on replay; older cached loads lack parts.
  const partIds = setup.parts ?? ['main'];
  const single = partIds.length === 1;
  const name = (base: string, part: string) => (single ? base : `${base}:${part}`);
  /** On failure cancel every submitted segment: the others are still running upstream and keep billing. */
  const fail = (code: string, message: string) =>
    step.do(`fail:${code}`, async () => {
      const job = await loadJob(deps.db, jobId);
      if (job) await cancelAll(adapter, upstreamIds(job));
      await markFailed(deps.db, jobId, 'failed', code, message);
      return true;
    });

  // Timeout counts from job creation and is only checked inside a step: on Workflow replay, code outside steps runs again.
  const deadline = setup.createdAt + setup.timeoutMinutes * 60_000;
  const prepCount = setup.prep ?? 0;
  /** Prep results: prep segment ID → image URL returned by the upstream; video segments' prep:<slot> placeholders are replaced with it at submit. */
  const prepUrls = new Map<string, string>();
  const submittedIds: string[] = [];
  const outputs: StoredOutput[] = [];
  /** Key of each segment's first output, looked up by segment ID when composing. */
  const partKeys = new Map<string, string>();
  const timeOut = () =>
    step.do('timeout', async () => {
      const job = await loadJob(deps.db, jobId);
      if (job) await cancelAll(adapter, upstreamIds(job));
      await markFailed(
        deps.db,
        jobId,
        'failed',
        'timeout',
        `no result after ${setup.timeoutMinutes} minutes`,
      );
      return true;
    });

  /** Upstream request for segment `index`: prep placeholders replaced with prep results. */
  const submitInput = (job: JobRow, index: number): SubmitInput => {
    const model = deps.models.find((m) => m.id === job.modelId)!;
    const part = partsOf(job, model)[index]!;
    const references = part.references.map((ref) => {
      if (!ref.url.startsWith(PREP_REF)) return ref;
      const url = prepUrls.get(`prep-${ref.url.slice(PREP_REF.length)}`);
      if (!url) throw new Error(`part ${part.id} needs ${ref.url} before it is ready`);
      return { ...ref, url };
    });
    return {
      upstreamModel: part.upstreamModel,
      kind: part.kind ?? model.kind,
      prompt: part.prompt,
      references,
      parameters: part.parameters,
      ...(part.maxCost ? { maxCost: part.maxCost } : {}),
    };
  };
  /** Poll until done; an empty label uses the single-part step name. */
  const pollUntilDone = async (upstreamJobId: string, label: string | null) => {
    for (let attempt = 0; ; attempt++) {
      const result: PollResult | { state: 'stopped' } | { state: 'timeout' } = await step.do(
        label === null ? `poll:${attempt}` : `poll:${label}:${attempt}`,
        async () => {
          // After a user cancel the local state is terminal; stop polling.
          const job = await loadJob(deps.db, jobId);
          if (!job || TERMINAL.includes(job.status)) return { state: 'stopped' as const };
          if (Date.now() > deadline) return { state: 'timeout' as const };
          return adapter.poll(upstreamJobId, POLL_WAIT_SECONDS);
        },
      );
      if (result.state !== 'running') return result;
      await step.sleep(label === null ? `pause:${attempt}` : `pause:${label}:${attempt}`, POLL_PAUSE_MS);
    }
  };
  /**
   * Poll every prep segment together until each finishes. A prep still running PREP_HEDGE_MS after job creation gets one copy,
   * since one stuck image holds back every video segment; the first copy to succeed is used and the other canceled (pollCopies).
   * Copies are not recorded in upstream_job_id (video segments haven't taken their positions yet): this loop cancels them when it sees
   * the job stopped or timed out. A user cancel terminates the Workflow, so a copy still running then is left to finish upstream (at most one prep maxCost).
   * Step names replaced the per-prep `poll:<prep>:<n>` of earlier versions: deploy with no effect job in flight, or a replayed job past prep re-polls its preps live.
   */
  type Finished = Exclude<PollResult, { state: 'running' }>;
  const pollPreps = async (
    pending: readonly { partId: string; index: number; upstreamJobId: string }[],
  ): Promise<
    { state: 'stopped' } | { state: 'timeout' } | { state: 'done'; results: Map<string, Finished> }
  > => {
    const results = new Map<string, Finished>();
    const copies = new Map<string, string>();
    const hedged = new Set<string>();
    for (let attempt = 0; ; attempt++) {
      const open = pending.filter((part) => !results.has(part.partId));
      const polled = await step.do(`poll:prep:${attempt}`, async () => {
        const job = await loadJob(deps.db, jobId);
        const stopped = !job || TERMINAL.includes(job.status);
        if (stopped || Date.now() > deadline) {
          await cancelAll(adapter, [...copies.values()]);
          return { state: stopped ? ('stopped' as const) : ('timeout' as const) };
        }
        const states = await Promise.all(
          open.map((part) => {
            const copy = copies.get(part.partId);
            return pollCopies(
              adapter,
              copy ? [part.upstreamJobId, copy] : [part.upstreamJobId],
              POLL_WAIT_SECONDS,
            );
          }),
        );
        const late = Date.now() - setup.createdAt > PREP_HEDGE_MS;
        return {
          state: 'polled' as const,
          results: Object.fromEntries(open.map((part, i) => [part.partId, states[i]!])),
          // Decided inside the step: replaying a cached poll must never hedge a prep that has since finished.
          hedge: open
            .filter((part, i) => late && states[i]!.state === 'running' && !hedged.has(part.partId))
            .map((part) => part.partId),
        };
      });
      if (polled.state !== 'polled') return polled;
      for (const [partId, result] of Object.entries(polled.results))
        if (result.state !== 'running') results.set(partId, result as Finished);
      for (const partId of polled.hedge) {
        hedged.add(partId);
        const part = pending.find((candidate) => candidate.partId === partId)!;
        // Best effort and no Workflow retries: if the copy can't be placed, keep waiting on the original.
        const copy = await step.do(`hedge:${partId}`, async () => {
          const job = await loadJob(deps.db, jobId);
          // A replay can resume here past the deadline: a copy then could never be used.
          if (!job || TERMINAL.includes(job.status) || Date.now() > deadline) return null;
          try {
            const { upstreamJobId } = await adapter.submit(
              submitInput(job, part.index),
              `${jobId}:${partId}:hedge`,
            );
            return upstreamJobId;
          } catch (error) {
            deps.log?.('prep hedge failed', { jobId, part: partId, error: String(error) });
            return null;
          }
        });
        if (copy) copies.set(partId, copy);
      }
      if (results.size === pending.length) return { state: 'done' as const, results };
      if (polled.hedge.length === 0) await step.sleep(`pause:prep:${attempt}`, POLL_PAUSE_MS);
    }
  };
  /** Rerun upstream task IDs go after all segments, appended in rerun order. */
  let retrySlots = 0;
  /**
   * Output check: if an original person this segment should replace is still in the output (swap didn't take) rerun this segment;
   * if reruns run out and it still didn't take, fail the whole job with a refund. Only slots the user filled are checked: the others keep the original on purpose.
   * Errors in the check itself (container failure) count as a pass, so a broken checker never refunds a good video. Returns false if the job has ended.
   */
  const verify = async (partId: string, index: number, check: SegmentCheck): Promise<boolean> => {
    const { original, faces } = check;
    for (let round = 0; ; round++) {
      const key = partKeys.get(partId);
      if (!key) return true;
      // Old-format checks still go through this loop: rounds an older version already ran replay from cache (with their scores,
      // reruns and stored outputs, so output numbering stays the same); rounds not run yet pass, since the old check no longer exists.
      const verdict = await step
        .do(`check:${partId}:${round}`, async () => {
          const job = await loadJob(deps.db, jobId);
          if (!job || TERMINAL.includes(job.status)) return { stopped: true as const };
          if (!original || !faces) return { scores: [] as number[] };
          const model = deps.models.find((m) => m.id === job.modelId)!;
          // Parts stored by older versions don't record their slots: check none rather than flag slots the user left as the original.
          const points = (partsOf(job, model)[index]!.slots ?? [])
            .map((slot) => faces[slot])
            .filter((point): point is readonly [number, number] => Boolean(point));
          if (!deps.composer || points.length === 0) return { scores: [] as number[] };
          const scores = await deps.composer.faces({
            jobId,
            key,
            originalKey: original,
            points,
            seconds: check.seconds,
          });
          return { scores };
        })
        .catch((error: unknown) => {
          deps.log?.('swap check errored, delivering as is', { jobId, part: partId, error: String(error) });
          return { scores: [] as number[] };
        });
      if ('stopped' in verdict) return false;
      const worst = Math.max(0, ...verdict.scores);
      if (worst < check.maxSimilarity) return true;
      deps.log?.('swap not applied', { jobId, part: partId, round, scores: verdict.scores });
      if (round >= check.retries) {
        await fail('swap_not_applied', `${partId} still shows an original face (similarity ${worst})`);
        return false;
      }
      const slot = partIds.length + retrySlots++;
      const label = `${partId}:retry${round + 1}`;
      const submitted = await step.do(`submit:${label}`, async () => {
        const job = await loadJob(deps.db, jobId);
        if (!job || TERMINAL.includes(job.status)) return { done: true as const };
        const existing = upstreamIds(job)[slot];
        if (existing) return { upstreamJobId: existing };
        if (Date.now() > deadline) return { timeout: true as const };
        try {
          const { upstreamJobId } = await adapter.submit(submitInput(job, index), `${jobId}:${label}`);
          if (!(await appendUpstreamJob(deps.db, jobId, slot, upstreamJobId))) {
            await adapter.cancel(upstreamJobId).catch(() => undefined);
            return { done: true as const };
          }
          return { upstreamJobId };
        } catch (error) {
          if (error instanceof UpstreamError && !error.retryable) {
            deps.log?.('upstream rejected retry', { jobId, part: label, code: error.code });
            await cancelAll(adapter, upstreamIds(job));
            await markFailed(deps.db, jobId, 'failed', error.code, error.message);
            return { done: true as const };
          }
          throw error;
        }
      });
      if ('done' in submitted) return false;
      if ('timeout' in submitted) {
        await timeOut();
        return false;
      }
      const result = await pollUntilDone(submitted.upstreamJobId, label);
      if (result.state === 'stopped') return false;
      if (result.state === 'timeout') {
        await timeOut();
        return false;
      }
      if (result.state === 'failed') {
        await fail(result.code, result.message);
        return false;
      }
      const start = outputs.length;
      const stored = await step.do(`store:${label}`, () => storeOutputs(deps, jobId, result.files, start));
      if (stored[0]) partKeys.set(partId, stored[0].key);
      outputs.push(...stored);
    }
  };

  // Run prep segments first, then video segments (which use the prep results). Within a phase, submit one by one so segments render upstream in parallel, then poll in turn.
  // Idempotency key is jobId for single-part, jobId:segment ID for multi-part.
  for (const [from, to] of [
    [0, prepCount],
    [prepCount, partIds.length],
  ] as const) {
    for (let index = from; index < to; index++) {
      const partId = partIds[index]!;
      const submitted = await step.do(name('submit', partId), async () => {
        const job = await loadJob(deps.db, jobId);
        if (!job || TERMINAL.includes(job.status)) return { done: true as const };
        const existing = upstreamIds(job)[index];
        if (existing) return { upstreamJobId: existing };
        // Prep may have used up the time: submitting video segments now would just waste upstream spend.
        if (index > 0 && Date.now() > deadline) return { timeout: true as const };
        try {
          const { upstreamJobId } = await adapter.submit(
            submitInput(job, index),
            single ? jobId : `${jobId}:${partId}`,
          );
          if (!(await appendUpstreamJob(deps.db, jobId, index, upstreamJobId))) {
            // The job was canceled during submit: nobody needs the task just placed, cancel it.
            await adapter.cancel(upstreamJobId).catch(() => undefined);
            return { done: true as const };
          }
          return { upstreamJobId };
        } catch (error) {
          if (error instanceof UpstreamError && !error.retryable && index < prepCount) {
            // Prep rejected (e.g. a celebrity photo): don't fail, record a placeholder and fall back to the original photo.
            deps.log?.('prep rejected, using original photo', { jobId, part: partId, code: error.code });
            const skipped = `${SKIPPED}${partId}`;
            if (!(await appendUpstreamJob(deps.db, jobId, index, skipped))) return { done: true as const };
            return { upstreamJobId: skipped };
          }
          if (error instanceof UpstreamError && !error.retryable) {
            deps.log?.('upstream rejected job', {
              jobId,
              part: partId,
              code: error.code,
              message: error.message,
            });
            await cancelAll(adapter, upstreamIds(job));
            await markFailed(deps.db, jobId, 'failed', error.code, error.message);
            return { done: true as const };
          }
          throw error;
        }
      });
      if ('done' in submitted) return;
      if ('timeout' in submitted) {
        await timeOut();
        return;
      }
      submittedIds[index] = submitted.upstreamJobId;
    }

    let prepResults = new Map<string, Finished>();
    if (from === 0 && prepCount > 0) {
      const pending = partIds
        .slice(0, prepCount)
        .map((partId, index) => ({ partId, index, upstreamJobId: submittedIds[index]! }))
        .filter((part) => !part.upstreamJobId.startsWith(SKIPPED));
      if (pending.length > 0) {
        const polled = await pollPreps(pending);
        if (polled.state === 'stopped') return;
        if (polled.state === 'timeout') {
          await timeOut();
          return;
        }
        prepResults = polled.results;
      }
    }

    for (let index = from; index < to; index++) {
      const partId = partIds[index]!;
      const upstreamJobId = submittedIds[index]!;
      /** When prep yields no image (rejected, failed, empty result), fall back to the user's original photo instead of failing the job. */
      const fallBack = async () => {
        const original = await step.do(`prep-fallback:${partId}`, async () => {
          const job = await loadJob(deps.db, jobId);
          if (!job || TERMINAL.includes(job.status)) return null;
          const model = deps.models.find((m) => m.id === job.modelId)!;
          return partsOf(job, model)[index]!.references[0]!.url;
        });
        if (original) prepUrls.set(partId, original);
        return Boolean(original);
      };
      if (upstreamJobId.startsWith(SKIPPED)) {
        if (!(await fallBack())) return;
        continue;
      }
      const result =
        index < prepCount
          ? prepResults.get(partId)!
          : await pollUntilDone(upstreamJobId, single ? null : partId);
      if (result.state === 'stopped') return;
      if (result.state === 'failed') {
        if (index < prepCount) {
          deps.log?.('prep failed, using original photo', { jobId, part: partId, code: result.code });
          if (!(await fallBack())) return;
          continue;
        }
        await fail(result.code, result.message);
        return;
      }
      if (result.state === 'timeout') {
        await timeOut();
        return;
      }
      if (index < prepCount) {
        // Prep results are only reference images for later video segments; not stored or delivered.
        const url = result.files[0]?.url;
        if (url) prepUrls.set(partId, url);
        else if (!(await fallBack())) return;
        continue;
      }
      const start = outputs.length;
      const stored = await step.do(name('store', partId), () =>
        storeOutputs(deps, jobId, result.files, start),
      );
      if (stored[0]) partKeys.set(partId, stored[0].key);
      outputs.push(...stored);
      const check = setup.checks?.[partId];
      if (check && !(await verify(partId, index, check))) return;
    }
  }
  let finalOutputs = outputs;
  if (setup.compose) {
    // Compose failures throw: once Workflow retries run out the fallback fails the job with a full refund. Retries write the same keys, so it's idempotent.
    const composed = await step.do('compose', () => composeOutputs(deps, jobId, partKeys, outputs.length));
    if (!composed) return;
    finalOutputs = composed;
  }
  await step.do('finish', async () => {
    await markSucceeded(deps.db, jobId, finalOutputs);
    return true;
  });
  if (!deps.notify) return;
  const notify = deps.notify;
  // Notification is best-effort: if it still fails after retries, only log it; it must not hit runGeneration's fallback failure path.
  await step
    .do('notify', async () => {
      const job = await loadJob(deps.db, jobId);
      // Only notify truly succeeded jobs: the user may have canceled before finish.
      if (job?.status === 'succeeded') await notify(job);
      return true;
    })
    .catch((error: unknown) => deps.log?.('notify failed', { jobId, error: String(error) }));
}

/** Stitch the output in effect segment order: rendered segments use model outputs, the rest use base clips. Stored as a with-track and a silent file. */
async function composeOutputs(
  deps: RunnerDeps,
  jobId: string,
  partKeys: ReadonlyMap<string, string>,
  startIndex: number,
): Promise<StoredOutput[] | null> {
  const job = await loadJob(deps.db, jobId);
  if (!job || TERMINAL.includes(job.status)) return null;
  const effect = deps.models.find((m) => m.id === job.modelId)?.effect;
  if (!effect?.compose) throw new Error(`model ${job.modelId} has no compose config`);
  if (!deps.composer) throw new Error('compose is not configured for this site');
  const segments: ComposeSegment[] = effect.segments.map((segment) => {
    const rendered = partKeys.get(segment.id);
    return rendered
      ? { key: rendered, target: segment.target!, fit: segment.fit ?? 'stretch' }
      : { key: segment.base!, target: segment.target!, fit: 'stretch' };
  });
  const { audio, audioStart, audioDuration, width, height, fps } = effect.compose;
  const result = await deps.composer.compose({
    jobId,
    segments,
    audio: { key: audio, start: audioStart, duration: audioDuration },
    width,
    height,
    fps,
  });
  const song = `jobs/${jobId}/${startIndex}.mp4`;
  const silent = `jobs/${jobId}/${startIndex + 1}.mp4`;
  const meta = { httpMetadata: { contentType: 'video/mp4' } };
  await deps.bucket.put(song, result.song, meta);
  await deps.bucket.put(silent, result.silent, meta);
  return [
    { key: song, mediaType: 'video/mp4' },
    { key: silent, mediaType: 'video/mp4' },
  ];
}

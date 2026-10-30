import { describe, expect, it } from 'vitest';
import { publicJob } from '../src/handlers';
import type { JobRow } from '../src/schema';

describe('publicJob', () => {
  it('returns the failure code but never the stored message', () => {
    const job = {
      id: 'job_1',
      modelId: 'demo',
      status: 'failed',
      prompt: '',
      costCredits: 10,
      outputsJson: null,
      errorCode: 'swap_not_applied',
      errorMessage: 'full still shows an original face (similarity 0.52)',
      createdAt: 1,
      finishedAt: 2,
    } as unknown as JobRow;
    const body = publicJob(job, 'https://example.com');
    expect(body.error).toEqual({ code: 'swap_not_applied' });
    expect(JSON.stringify(body)).not.toContain('similarity');
  });
});

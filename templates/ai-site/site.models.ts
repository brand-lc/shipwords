import { defineModels } from '@shipwords/jobs/models';

// Models available on this site. credits is charged per job; models with guest: true can be tried free by guests.
// The tool page imports this file, so all of it ships to the browser. An effect keeps only its public part here (id, name, price, slots)
// and adds prompts, reference clips and checks in src/models.server.ts, which core.server.ts and server.ts then import instead.
export default defineModels([
  {
    id: 'nano-banana-pro',
    name: 'Nano Banana Pro',
    kind: 'image',
    upstream: 'yir',
    upstreamModel: 'google/nano-banana-pro',
    credits: 10,
    guest: true,
    allowedParameters: ['aspect_ratio'],
    defaults: { aspect_ratio: '1:1' },
    maxReferences: 4,
    maxCost: '0.30',
    timeoutMinutes: 10,
  },
  {
    id: 'gpt-image-2',
    name: 'GPT Image 2',
    kind: 'image',
    upstream: 'yir',
    upstreamModel: 'openai/gpt-image-2',
    credits: 15,
    guest: false,
    allowedParameters: ['aspect_ratio'],
    defaults: { aspect_ratio: '1:1' },
    maxReferences: 4,
    maxCost: '0.40',
    timeoutMinutes: 10,
  },
]);

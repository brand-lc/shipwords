import { definePublicModels } from '@shipwords/jobs/models';

// Models available on this site, as pages see them: credits is charged per job; models with guest: true can be tried free by guests.
// Pages import this file, so it ships to the browser. Upstream models, cost caps and effect presets go in src/models.server.ts;
// definePublicModels throws on any other field.
export default definePublicModels([
  {
    id: 'nano-banana-pro',
    name: 'Nano Banana Pro',
    kind: 'image',
    credits: 10,
    guest: true,
    allowedParameters: ['aspect_ratio'],
    defaults: { aspect_ratio: '1:1' },
    maxReferences: 4,
  },
  {
    id: 'gpt-image-2',
    name: 'GPT Image 2',
    kind: 'image',
    credits: 15,
    guest: false,
    allowedParameters: ['aspect_ratio'],
    defaults: { aspect_ratio: '1:1' },
    maxReferences: 4,
  },
]);

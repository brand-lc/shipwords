import { definePublicModels } from '@shipwords/jobs/models';

// The tool page imports this file, so it ends up in the browser bundle: keep only what the page shows (id, name, price, slots).
// Prompts, the upstream model, reference clips and checks live in src/models.server.ts, keyed by id; definePublicModels throws on any other field here.

export default definePublicModels([
  {
    id: 'tiny-desk',
    name: 'Tiny Desk video',
    kind: 'video',
    credits: 10,
    guest: false,
    allowedParameters: [],
    maxReferences: 0,
    effect: {
      slots: [
        { id: 'lead', label: 'Lead vocals', required: false },
        { id: 'sax', label: 'Sax', required: false },
        { id: 'keys', label: 'Keys', required: false },
        { id: 'backLeft', label: 'Backing vocals (left)', required: false },
        { id: 'backRight', label: 'Backing vocals (right)', required: false },
      ],
    },
  },
]);

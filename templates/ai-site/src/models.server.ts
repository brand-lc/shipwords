import { serverModels } from '@shipwords/jobs/models';
import catalog from '../site.models';

// Server only (never import from pages): the upstream side of each model in site.models.ts, by ID.
export default serverModels(catalog, {
  'nano-banana-pro': {
    upstream: 'yir',
    upstreamModel: 'google/nano-banana-pro',
    maxCost: '0.30',
    timeoutMinutes: 10,
  },
  'gpt-image-2': {
    upstream: 'yir',
    upstreamModel: 'openai/gpt-image-2',
    maxCost: '0.40',
    timeoutMinutes: 10,
  },
});

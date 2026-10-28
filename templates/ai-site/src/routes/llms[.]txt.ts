import { llmsTxt } from '@shipwords/core/seo';
import { createFileRoute } from '@tanstack/react-router';
import site from '../../site.config';

export const Route = createFileRoute('/llms.txt')({
  server: {
    handlers: {
      GET: () =>
        llmsTxt(site, 'An AI image generator. Describe an image and get it in seconds; free to try.', [
          { title: 'AI Image Generator', path: '/', description: 'Generate images from a text prompt.' },
          { title: 'Pricing', path: '/#pricing', description: 'Credit packs and subscriptions.' },
        ]),
    },
  },
});

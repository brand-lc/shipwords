import { createFileRoute } from '@tanstack/react-router';
import { core } from '~/core.server';

// In the Stripe dashboard set the webhook URL to https://<domain>/api/webhooks/stripe; events are listed in docs/site-launch.md.
export const Route = createFileRoute('/api/webhooks/stripe')({
  server: { handlers: { POST: ({ request }) => core.billing.webhook(request) } },
});

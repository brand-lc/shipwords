import { createFileRoute, redirect } from '@tanstack/react-router';

// No separate pricing page (an extra hop hurts conversion): /pricing 301s to the home pricing section; the dialog is in ~/site/pricing.
export const Route = createFileRoute('/pricing')({
  beforeLoad: () => {
    throw redirect({ to: '/', hash: 'pricing', statusCode: 301 });
  },
});

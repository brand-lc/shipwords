import { pageHead } from '@shipwords/core/seo';
import { createFileRoute } from '@tanstack/react-router';
import { m } from '~/paraglide/messages.js';
import { LegalPage } from '~/site/legal';
import site from '../../site.config';

export const Route = createFileRoute('/refunds')({
  head: () =>
    pageHead(site, {
      title: m.legal_refunds_meta_title({ siteName: site.name }),
      description: m.legal_refunds_meta_description({ siteName: site.name }),
      path: '/refunds',
    }),
  component: RefundsPage,
});

function RefundsPage() {
  return (
    <LegalPage title={m.legal_refunds_title()} intro={m.legal_refunds_intro({ siteName: site.name })}>
      <h2>{m.legal_refunds_failed_heading()}</h2>
      <p>{m.legal_refunds_failed_body()}</p>

      <h2>{m.legal_refunds_unused_heading()}</h2>
      <p>{m.legal_refunds_unused_body()}</p>

      <h2>{m.legal_refunds_ask_heading()}</h2>
      <p>{m.legal_refunds_ask_body()}</p>
    </LegalPage>
  );
}

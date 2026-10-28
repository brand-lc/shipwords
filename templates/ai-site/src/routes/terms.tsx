import { pageHead } from '@shipwords/core/seo';
import { createFileRoute } from '@tanstack/react-router';
import { m } from '~/paraglide/messages.js';
import { LegalPage } from '~/site/legal';
import site from '../../site.config';

export const Route = createFileRoute('/terms')({
  head: () =>
    pageHead(site, {
      title: m.legal_terms_meta_title({ siteName: site.name }),
      description: m.legal_terms_meta_description({ siteName: site.name }),
      path: '/terms',
    }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <LegalPage title={m.legal_terms_title()} intro={m.legal_terms_intro({ siteName: site.name })}>
      <h2>{m.legal_terms_service_heading()}</h2>
      <p>{m.legal_terms_service_body()}</p>

      <h2>{m.legal_terms_content_heading()}</h2>
      <p>{m.legal_terms_content_body()}</p>

      <h2>{m.legal_terms_credits_heading()}</h2>
      <p>{m.legal_terms_credits_body()}</p>

      <h2>{m.legal_terms_warranty_heading()}</h2>
      <p>{m.legal_terms_warranty_body()}</p>
    </LegalPage>
  );
}

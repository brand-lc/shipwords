import { pageHead } from '@shipwords/core/seo';
import { createFileRoute } from '@tanstack/react-router';
import { m } from '~/paraglide/messages.js';
import { LegalPage } from '~/site/legal';
import site from '../../site.config';

export const Route = createFileRoute('/privacy')({
  head: () =>
    pageHead(site, {
      title: m.legal_privacy_meta_title({ siteName: site.name }),
      description: m.legal_privacy_meta_description({ siteName: site.name }),
      path: '/privacy',
    }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <LegalPage title={m.legal_privacy_title()} intro={m.legal_privacy_intro({ siteName: site.name })}>
      <h2>{m.legal_privacy_collect_heading()}</h2>
      <p>{m.legal_privacy_collect_body()}</p>

      <h2>{m.legal_privacy_processors_heading()}</h2>
      <p>{m.legal_privacy_processors_body()}</p>

      <h2>{m.legal_privacy_retention_heading()}</h2>
      <p>{m.legal_privacy_retention_body()}</p>

      <h2>{m.legal_privacy_cookies_heading()}</h2>
      <p>{m.legal_privacy_cookies_body()}</p>

      <h2>{m.legal_privacy_choices_heading()}</h2>
      <p>{m.legal_privacy_choices_body()}</p>
    </LegalPage>
  );
}

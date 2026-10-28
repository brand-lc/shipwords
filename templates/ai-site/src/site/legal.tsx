import type { ReactNode } from 'react';
import { m } from '~/paraglide/messages.js';

// Shared layout for the privacy, terms, refunds and DMCA pages. Text lives in messages/legal; write it for this site before launch
// and remove every TODO (check-site blocks on them). The policy date is common_legal_policy_date in messages/common.

/** Support email, forwarded to your inbox by Cloudflare Email Routing. new-site sets the domain; check-site rejects example.com. */
export const SUPPORT_EMAIL = 'support@example.com';

export function LegalPage({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <article className="legal">
      <h1>{title}</h1>
      <p className="muted">{m.common_legal_updated({ date: m.common_legal_policy_date() })}</p>
      <p>{intro}</p>
      {children}
      <p>
        {m.common_legal_questions()} <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </article>
  );
}

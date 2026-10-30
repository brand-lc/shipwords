import type { Db } from '@shipwords/core/db/client';
import { user } from '@shipwords/core/db/schema';
import { emailCopy } from '@shipwords/core/email/copy';
import type { SiteConfig } from '@shipwords/core/site';
import { eq } from 'drizzle-orm';
import type { StoredOutput } from './lifecycle';
import type { JobRow } from './schema';

/**
 * When a job ends, email signed-in users so they don't wait on the page: on success a direct result link, on failure that nothing was
 * charged and the credits are back (the runner only notifies after the refund settled). Guest jobs have no email, so nothing is sent.
 * The copy follows the site's defaultLocale.
 */
export function emailOnFinish(options: {
  db: Db;
  email: SendEmail;
  from: string;
  site: Pick<SiteConfig, 'name' | 'defaultLocale'>;
  baseURL: string;
}) {
  const { db, email, from, site, baseURL } = options;
  const copy = emailCopy(site.defaultLocale);
  return async (job: JobRow) => {
    if (!job.userId || (job.status !== 'succeeded' && job.status !== 'failed')) return;
    const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, job.userId)).limit(1);
    if (!row) return;
    const sender = { email: from, name: site.name };
    if (job.status === 'failed') {
      await email.send({
        to: row.email,
        from: sender,
        ...copy.jobFailed({ siteName: site.name, kind: job.kind, costCredits: job.costCredits, baseURL }),
      });
      return;
    }
    const [first] = job.outputsJson ? (JSON.parse(job.outputsJson) as StoredOutput[]) : [];
    const resultURL = first ? `${baseURL}/files/${first.key}` : `${baseURL}/`;
    await email.send({
      to: row.email,
      from: sender,
      ...copy.jobReady({ siteName: site.name, kind: job.kind, resultURL, baseURL }),
    });
  };
}

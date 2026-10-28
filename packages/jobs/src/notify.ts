import type { Db } from '@shipwords/core/db/client';
import { user } from '@shipwords/core/db/schema';
import type { SiteConfig } from '@shipwords/core/site';
import { eq } from 'drizzle-orm';
import type { StoredOutput } from './lifecycle';
import type { JobRow } from './schema';

/**
 * When a job ends, email signed-in users so they don't wait on the page: on success a direct result link, on failure that nothing was
 * charged and the credits are back (the runner only notifies after the refund settled). Guest jobs have no email, so nothing is sent.
 */
export function emailOnFinish(options: {
  db: Db;
  email: SendEmail;
  from: string;
  site: Pick<SiteConfig, 'name'>;
  baseURL: string;
}) {
  const { db, email, from, site, baseURL } = options;
  return async (job: JobRow) => {
    if (!job.userId || (job.status !== 'succeeded' && job.status !== 'failed')) return;
    const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, job.userId)).limit(1);
    if (!row) return;
    const what = job.kind === 'video' ? 'video' : 'image';
    const sender = { email: from, name: site.name };
    if (job.status === 'failed') {
      const charge =
        job.costCredits > 0
          ? `You weren't charged: the ${job.costCredits} credits for it are back in your account.`
          : `You weren't charged for it.`;
      await email.send({
        to: row.email,
        from: sender,
        subject: `Your ${site.name} ${what} couldn't be made`,
        text: `Sorry, we couldn't make your ${what} this time. ${charge}\n\nYou can try again on ${baseURL}/.`,
        html: `<p>Sorry, we couldn't make your ${what} this time.</p><p>${charge}</p><p><a href="${baseURL}/" style="font-size:18px;font-weight:bold">Try again on ${site.name}</a></p>`,
      });
      return;
    }
    const [first] = job.outputsJson ? (JSON.parse(job.outputsJson) as StoredOutput[]) : [];
    const resultURL = first ? `${baseURL}/files/${first.key}` : `${baseURL}/`;
    await email.send({
      to: row.email,
      from: sender,
      subject: `Your ${site.name} ${what} is ready`,
      text: `Your ${what} is ready: ${resultURL}\n\nAll your results are on ${baseURL}/ when you sign in.`,
      html: `<p>Your ${what} is ready.</p><p><a href="${resultURL}" style="font-size:18px;font-weight:bold">Open your ${what}</a></p><p>All your results are on <a href="${baseURL}/">${site.name}</a> when you sign in.</p>`,
    });
  };
}

import type { Db } from '@shipwords/core/db/client';
import { user } from '@shipwords/core/db/schema';
import type { SiteConfig } from '@shipwords/core/site';
import { eq } from 'drizzle-orm';
import type { StoredOutput } from './lifecycle';
import type { JobRow } from './schema';

/** After success, email signed-in users a direct result link and the site entry. Guest jobs have no email, so nothing is sent. */
export function emailOnSuccess(options: {
  db: Db;
  email: SendEmail;
  from: string;
  site: Pick<SiteConfig, 'name'>;
  baseURL: string;
}) {
  const { db, email, from, site, baseURL } = options;
  return async (job: JobRow) => {
    if (!job.userId) return;
    const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, job.userId)).limit(1);
    if (!row) return;
    const what = job.kind === 'video' ? 'video' : 'image';
    const [first] = job.outputsJson ? (JSON.parse(job.outputsJson) as StoredOutput[]) : [];
    const resultURL = first ? `${baseURL}/files/${first.key}` : `${baseURL}/`;
    await email.send({
      to: row.email,
      from: { email: from, name: site.name },
      subject: `Your ${site.name} ${what} is ready`,
      text: `Your ${what} is ready: ${resultURL}\n\nAll your results are on ${baseURL}/ when you sign in.`,
      html: `<p>Your ${what} is ready.</p><p><a href="${resultURL}" style="font-size:18px;font-weight:bold">Open your ${what}</a></p><p>All your results are on <a href="${baseURL}/">${site.name}</a> when you sign in.</p>`,
    });
  };
}

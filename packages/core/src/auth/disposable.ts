import { DISPOSABLE_DOMAINS } from './disposable-domains.gen';

let domains: Set<string> | null = null;

/** Whether an email is from a disposable domain, subdomains included (e.g. a.mailinator.com). */
export function isDisposableEmail(email: string): boolean {
  domains ??= new Set(DISPOSABLE_DOMAINS.split(' '));
  const host = email.trim().toLowerCase().split('@')[1];
  if (!host) return false;
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (domains.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

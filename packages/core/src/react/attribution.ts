// Records where the visitor came from in a cookie; the server reads it at sign-up and stores it in user_attribution.
// The first visit with a source wins: a direct visit (no UTM, no outside referrer) is replaced by a later sourced one,
// so someone who first opened the site from an in-app browser and came back from Google or ChatGPT is credited there.

const COOKIE = 'sh_attr';
// Returning from checkout or our own pages is not a source.
const NOT_A_SOURCE = /(^|\.)(stripe\.com|paypal\.com|creem\.io|lemonsqueezy\.com|paddle\.com)$/;

export interface Touch {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  referrer: string | null;
  landing_path: string;
}

function hasSource(touch: Touch) {
  return Boolean(touch.utm_source || touch.referrer);
}

export function currentTouch(url: string, referrer: string): Touch {
  const { searchParams, pathname, hostname } = new URL(url);
  let source: string | null = null;
  try {
    const from = new URL(referrer).hostname;
    if (from !== hostname && !NOT_A_SOURCE.test(from)) source = referrer;
  } catch {}
  return {
    utm_source: searchParams.get('utm_source'),
    utm_medium: searchParams.get('utm_medium'),
    utm_campaign: searchParams.get('utm_campaign'),
    referrer: source,
    landing_path: pathname,
  };
}

/** The touch to store, or null to keep the stored one. */
export function nextTouch(stored: Touch | null, current: Touch): Touch | null {
  if (!stored) return current;
  return !hasSource(stored) && hasSource(current) ? current : null;
}

function readStored(): Touch | null {
  const raw = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(raw.slice(COOKIE.length + 1)));
  } catch {
    return null;
  }
}

export function captureAttribution() {
  if (typeof document === 'undefined') return;
  const touch = nextTouch(readStored(), currentTouch(window.location.href, document.referrer));
  if (!touch) return;
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API isn't available in Safari yet.
  document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(touch))}; Path=/; Max-Age=${60 * 86_400}; SameSite=Lax; Secure`;
}

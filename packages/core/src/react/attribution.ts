// Records the referrer and UTM on first landing in a cookie; the server reads it at sign-up and stores it in user_attribution.

const COOKIE = 'sh_attr';

export function captureAttribution() {
  if (typeof document === 'undefined' || document.cookie.includes(`${COOKIE}=`)) return;
  const params = new URLSearchParams(window.location.search);
  const value = {
    utm_source: params.get('utm_source'),
    utm_medium: params.get('utm_medium'),
    utm_campaign: params.get('utm_campaign'),
    referrer: document.referrer || null,
    landing_path: window.location.pathname,
  };
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API isn't available in Safari yet.
  document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(value))}; Path=/; Max-Age=${60 * 86_400}; SameSite=Lax; Secure`;
}

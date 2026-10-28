// Browser side of reCAPTCHA v3 (Google Cloud reCAPTCHA): the script loads only when a token is first needed, so first paint isn't affected.

declare global {
  interface Window {
    grecaptcha?: {
      enterprise: {
        ready(callback: () => void): void;
        execute(siteKey: string, options: { action: string }): Promise<string>;
      };
    };
  }
}

let loading: Promise<void> | null = null;

function load(siteKey: string): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://www.google.com/recaptcha/enterprise.js?render=${encodeURIComponent(siteKey)}`;
    script.async = true;
    script.onload = () => window.grecaptcha?.enterprise.ready(() => resolve());
    script.onerror = () => {
      loading = null;
      reject(new Error('failed to load reCAPTCHA'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export async function getRecaptchaToken(siteKey: string, action: string): Promise<string | null> {
  if (!siteKey || typeof window === 'undefined') return null;
  try {
    await load(siteKey);
    return (await window.grecaptcha?.enterprise.execute(siteKey, { action })) ?? null;
  } catch {
    return null;
  }
}

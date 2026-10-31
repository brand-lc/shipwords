import { describe, expect, it } from 'vitest';
import { currentTouch, nextTouch } from '../src/react/attribution';

const SITE = 'https://site.io';

describe('attribution touch', () => {
  it('keeps UTM and outside referrers', () => {
    expect(currentTouch(`${SITE}/free?utm_source=chatgpt.com`, '')).toMatchObject({
      utm_source: 'chatgpt.com',
      referrer: null,
      landing_path: '/free',
    });
    expect(currentTouch(`${SITE}/`, 'https://www.google.com/').referrer).toBe('https://www.google.com/');
  });

  it('does not count our own pages or checkout as a referrer', () => {
    expect(currentTouch(`${SITE}/`, `${SITE}/pricing`).referrer).toBeNull();
    expect(currentTouch(`${SITE}/billing/return`, 'https://checkout.stripe.com/').referrer).toBeNull();
    expect(currentTouch(`${SITE}/`, 'not a url').referrer).toBeNull();
  });

  it('stores the first visit, and replaces a direct one with the first visit that has a source', () => {
    const direct = currentTouch(`${SITE}/`, '');
    const google = currentTouch(`${SITE}/`, 'https://www.google.com/');
    const chatgpt = currentTouch(`${SITE}/?utm_source=chatgpt.com`, '');
    expect(nextTouch(null, direct)).toEqual(direct);
    expect(nextTouch(direct, direct)).toBeNull();
    expect(nextTouch(direct, google)).toEqual(google);
    expect(nextTouch(google, chatgpt)).toBeNull();
    expect(nextTouch(google, direct)).toBeNull();
  });
});

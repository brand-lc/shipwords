// GA4 and Rybbit, production host only, skipped under GPC/DNT. Rybbit loads through /stats/ on this site (proxied by src/worker.ts).
(() => {
  if (location.hostname !== 'shipwords.dev') return;
  // Respect Global Privacy Control and Do Not Track (stated on /privacy/).
  if (navigator.globalPrivacyControl || navigator.doNotTrack === '1') return;
  const GA4 = 'G-PJDL19FZTG';
  const RYBBIT_SITE_ID = '9269eef8a2bd';
  const load = (src) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    document.head.appendChild(s);
  };
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    // biome-ignore lint/complexity/noArguments: gtag.js only reads Arguments objects from dataLayer, not arrays
    window.dataLayer.push(arguments);
  };
  window.gtag('js', new Date());
  window.gtag('config', GA4);
  load(`https://www.googletagmanager.com/gtag/js?id=${GA4}`);
  load(`/stats/script.js?siteId=${RYBBIT_SITE_ID}`);
})();

// Decoration only: the page reads fine with scripts off.
(() => {
  document.documentElement.classList.add('js');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sites = [
    ['tiny-desk-ai', 'Tiny Desk AI'],
    ['ghibli-photo', 'Ghibli Photo'],
    ['ai-baby', 'AI Baby'],
    ['pet-portrait', 'Pet Portrait AI'],
    ['hug-video', 'AI Hug Video'],
  ];

  // Hero background loop: wide screens only, never with reduced motion; phones keep the still image.
  const loop = document.querySelector('.hero-video');
  if (loop && !still && matchMedia('(min-width: 768px)').matches) {
    loop.addEventListener('playing', () => loop.classList.add('on'), { once: true });
    loop.src = loop.dataset.src;
    loop.play().catch(() => {});
  }

  // Hero prompt cycles through example keywords.
  const kw = document.getElementById('kw');
  let i = 0;
  // The keyword is an input sized to its text; once the visitor touches it, rotation stops for good.
  const fit = () => (kw.size = Math.max(kw.value.length, 4));
  let timer;
  for (const type of ['focus', 'pointerdown', 'input']) kw.addEventListener(type, () => clearInterval(timer));
  kw.addEventListener('input', fit);
  if (!still) {
    timer = setInterval(() => {
      i = (i + 1) % sites.length;
      kw.value = sites[i][0].replaceAll('-', ' ');
      fit();
    }, 2800);
  }

  // Copy buttons flash a done state; text buttons swap to their data-done label.
  // When the clipboard is blocked, select the source text and say so instead of failing silently.
  const copy = (text, el, source) => {
    const flash = (cls, msg) => {
      const label = el.querySelector('span');
      const old = label?.textContent;
      el.classList.add(cls);
      if (label && msg) label.textContent = msg;
      if (!label && msg) el.title = msg;
      setTimeout(
        () => {
          el.classList.remove(cls);
          if (label && msg) label.textContent = old;
        },
        cls === 'fail' ? 3200 : 1400,
      );
    };
    const fail = () => {
      getSelection().selectAllChildren(source);
      flash('fail', el.dataset.fail);
    };
    if (!navigator.clipboard) return fail();
    navigator.clipboard.writeText(text).then(() => flash('done', el.dataset.done), fail);
  };
  const cmd = kw.closest('.cmd');
  document.getElementById('copy-hero').onclick = (e) =>
    copy(cmd.dataset.copy.replace('{kw}', kw.value.trim() || kw.defaultValue), e.currentTarget, cmd);
  // Mock site window: one visitor walks the whole paid path, and each ready-at-launch check ticks as its step happens.
  // Order follows the side list: guest try, AI generation, Google sign-in, credit pack, Stripe. Plays only while in view.
  const stage = document.querySelector('.stage.sky-a');
  const checks = [...stage.querySelectorAll('.check')];
  if (still) for (const c of checks) c.classList.add('on');
  else {
    const $ = (sel) => stage.querySelector(sel);
    const img = $('#site-img');
    const tries = $('#tries');
    const cr = $('#cr');
    const states = [
      'is-guest',
      'is-empty',
      'is-busy',
      'is-login',
      'is-user',
      'is-pay',
      'is-picked',
      'is-toast',
    ];
    const set = (on, off = []) => {
      stage.classList.add(...on);
      stage.classList.remove(...off);
    };
    const tick = (n) => checks[n].classList.add('on');
    const press = (sel) => {
      $(sel).classList.add('press');
      setTimeout(() => $(sel).classList.remove('press'), 260);
    };
    const count = (to) => {
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min((t - t0) / 700, 1);
        cr.textContent = Math.round(to * (1 - (1 - k) ** 3));
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    let site = sites.length - 1;
    let timers = [];
    const story = [
      [
        0,
        () => {
          site = (site + 1) % sites.length;
          $('#site-url').textContent = `${sites[site][0]}.com`;
          $('#site-kw').textContent = sites[site][1];
          img.src = `/img/result/${sites[site][0]}.webp`;
          tries.textContent = 1;
          cr.textContent = 0;
          stage.classList.remove(...states);
          $('.paybtn').classList.remove('wait');
          for (const c of checks) c.classList.remove('on');
          set(['snap', 'play', 'is-guest', 'is-empty']);
          requestAnimationFrame(() => requestAnimationFrame(() => stage.classList.remove('snap')));
        },
      ],
      [
        900,
        () => {
          press('.drop b');
          set(['is-busy']);
          tick(0);
        },
      ],
      [
        2500,
        () => {
          set([], ['is-busy', 'is-empty']);
          tries.textContent = 0;
          tick(1);
        },
      ],
      [4200, () => press('.drop b')],
      [4500, () => set(['is-login'])],
      [5600, () => press('.gbtn')],
      [
        6100,
        () => {
          set(['is-user'], ['is-login', 'is-guest']);
          tick(2);
        },
      ],
      [6900, () => set(['is-pay'])],
      [7700, () => set(['is-picked'])],
      [
        8500,
        () => {
          press('.paybtn');
          $('.paybtn').classList.add('wait');
        },
      ],
      [
        9500,
        () => {
          set(['is-toast'], ['is-pay']);
          count(120);
          tick(3);
          tick(4);
        },
      ],
      [13500, () => set([], ['is-toast'])],
    ];
    const LOOP = 14200;
    const play = () => {
      for (const [ms, fn] of story) timers.push(setTimeout(fn, ms));
      timers.push(setTimeout(play, LOOP));
    };
    const stop = () => {
      timers.forEach(clearTimeout);
      timers = [];
      stage.classList.remove('play', ...states);
      cr.textContent = 120;
      for (const c of checks) c.classList.add('on');
    };
    for (const [s] of sites) new Image().src = `/img/result/${s}.webp`;
    new IntersectionObserver(([e]) => (e.isIntersecting ? timers.length || play() : stop()), {
      threshold: 0.35,
    }).observe(stage);
  }

  // Showcase clips: load and play only while in view (never with reduced motion); one clip has sound at a time.
  const clips = [...document.querySelectorAll('.clip')];
  const unmute = (clip, on) => {
    const v = clip.querySelector('video');
    v.muted = !on;
    clip.querySelector('.sound').setAttribute('aria-pressed', String(on));
  };
  for (const clip of clips) {
    const v = clip.querySelector('video');
    const start = () => {
      if (!v.src) v.src = v.dataset.src;
      v.play().catch(() => {});
    };
    const toggle = () => {
      const on = v.muted;
      for (const c of clips) unmute(c, false);
      if (on) {
        unmute(clip, true);
        start();
      }
    };
    v.onclick = toggle;
    clip.querySelector('.sound').onclick = toggle;
    new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && (!still || !v.muted)) start();
        else if (!e.isIntersecting) v.pause();
      },
      { threshold: 0.4 },
    ).observe(v);
  }

  // Floating bar once the hero is out of view.
  const bar = document.getElementById('bar');
  new IntersectionObserver(([e]) => {
    const on = !e.isIntersecting && e.boundingClientRect.top < 0;
    bar.classList.toggle('on', on);
    bar.inert = !on;
  }).observe(document.querySelector('.prompt'));

  // Keyword chips drifting over the meadow (doubled for a seamless loop).
  const words = [
    ['ai baby generator', 'w'],
    ['ghibli photo', ''],
    ['pet portrait ai', 'p'],
    ['tiny desk ai', ''],
    ['ai hug video', 'v'],
    ['old photo restore', ''],
    ['ai headshot', 'w'],
    ['sticker maker', ''],
    ['ai yearbook', 'p'],
    ['action figure ai', ''],
    ['ai dance video', 'v'],
    ['remove watermark', ''],
  ];
  const fill = (lane, list) => {
    const html = list.map(([w, c]) => `<span class="chip ${c}">${w}<small>→ .com</small></span>`).join('');
    lane.innerHTML = html + html;
  };
  fill(document.getElementById('lane-a'), words.slice(0, 6).concat(words.slice(0, 6)));
  fill(document.getElementById('lane-b'), words.slice(6).concat(words.slice(6)));

  // Chinese browsers on the English page get a one-time hint to switch; never an automatic redirect.
  const stored = (key, value) => {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch {}
  };
  if (
    document.documentElement.lang === 'en' &&
    navigator.languages.some((l) => /^zh(-|$)/i.test(l)) &&
    !stored('lang-hint')
  ) {
    const hint = document.createElement('div');
    hint.className = 'lang-hint';
    hint.lang = 'zh-Hans';
    hint.innerHTML =
      '<span>这个页面有中文版</span><a href="/zh/" hreflang="zh-Hans">切换到中文</a><button type="button" aria-label="关闭">×</button>';
    const close = () => {
      stored('lang-hint', '1');
      hint.remove();
    };
    hint.querySelector('a').addEventListener('click', () => stored('lang-hint', '1'));
    hint.querySelector('button').onclick = close;
    document.body.append(hint);
  }
})();

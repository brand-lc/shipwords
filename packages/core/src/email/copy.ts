// Built-in copy for the emails the engine sends (sign-in codes, job finished). The language follows the site's defaultLocale;
// languages without copy here fall back to English.

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

export type JobKind = 'image' | 'video' | 'music';

export interface EmailCopy {
  signInCode(input: { siteName: string; otp: string }): EmailMessage;
  jobReady(input: { siteName: string; kind: JobKind; resultURL: string; baseURL: string }): EmailMessage;
  jobFailed(input: { siteName: string; kind: JobKind; costCredits: number; baseURL: string }): EmailMessage;
}

const codeStyle = 'font-size:20px';
const linkStyle = 'font-size:18px;font-weight:bold';

const en: EmailCopy = {
  signInCode: ({ siteName, otp }) => ({
    subject: `${otp} is your ${siteName} code`,
    text: `Your ${siteName} sign-in code is ${otp}. It expires in 10 minutes.`,
    html: `<p>Your ${siteName} sign-in code is <strong style="${codeStyle}">${otp}</strong>.</p><p>It expires in 10 minutes.</p>`,
  }),
  jobReady: ({ siteName, kind, resultURL, baseURL }) => {
    const what = kind === 'music' ? 'song' : kind;
    return {
      subject: `Your ${siteName} ${what} is ready`,
      text: `Your ${what} is ready: ${resultURL}\n\nAll your results are on ${baseURL}/ when you sign in.`,
      html: `<p>Your ${what} is ready.</p><p><a href="${resultURL}" style="${linkStyle}">Open your ${what}</a></p><p>All your results are on <a href="${baseURL}/">${siteName}</a> when you sign in.</p>`,
    };
  },
  jobFailed: ({ siteName, kind, costCredits, baseURL }) => {
    const what = kind === 'music' ? 'song' : kind;
    const charge =
      costCredits > 0
        ? `You weren't charged: the ${costCredits} credits for it are back in your account.`
        : `You weren't charged for it.`;
    return {
      subject: `Your ${siteName} ${what} couldn't be made`,
      text: `Sorry, we couldn't make your ${what} this time. ${charge}\n\nYou can try again on ${baseURL}/.`,
      html: `<p>Sorry, we couldn't make your ${what} this time.</p><p>${charge}</p><p><a href="${baseURL}/" style="${linkStyle}">Try again on ${siteName}</a></p>`,
    };
  },
};

const jaWhat: Record<JobKind, string> = { image: '画像', video: '動画', music: '曲' };

const ja: EmailCopy = {
  signInCode: ({ siteName, otp }) => ({
    subject: `${siteName}のログインコード：${otp}`,
    text: `${siteName}のログインコードは ${otp} です。10分間有効です。`,
    html: `<p>${siteName}のログインコードは <strong style="${codeStyle}">${otp}</strong> です。</p><p>10分間有効です。</p>`,
  }),
  jobReady: ({ siteName, kind, resultURL, baseURL }) => {
    const what = jaWhat[kind];
    return {
      subject: `${siteName}：${what}ができました`,
      text: `${what}ができました：${resultURL}\n\nログインすると、これまでの作品はすべて ${baseURL}/ で見られます。`,
      html: `<p>${what}ができました。</p><p><a href="${resultURL}" style="${linkStyle}">${what}を開く</a></p><p>ログインすると、これまでの作品はすべて<a href="${baseURL}/">${siteName}</a>で見られます。</p>`,
    };
  },
  jobFailed: ({ siteName, kind, costCredits, baseURL }) => {
    const what = jaWhat[kind];
    const charge =
      costCredits > 0
        ? `料金はかかっていません。使った${costCredits}クレジットはアカウントに戻っています。`
        : `料金はかかっていません。`;
    return {
      subject: `${siteName}：${what}を作れませんでした`,
      text: `申し訳ありません。今回は${what}を作れませんでした。${charge}\n\n${baseURL}/ からもう一度お試しください。`,
      html: `<p>申し訳ありません。今回は${what}を作れませんでした。</p><p>${charge}</p><p><a href="${baseURL}/" style="${linkStyle}">${siteName}でもう一度試す</a></p>`,
    };
  },
};

// Korean particles depend on the noun's final consonant, so each noun carries its subject and object forms.
const koWhat: Record<JobKind, { noun: string; subject: string; object: string }> = {
  image: { noun: '이미지', subject: '이미지가', object: '이미지를' },
  video: { noun: '영상', subject: '영상이', object: '영상을' },
  music: { noun: '노래', subject: '노래가', object: '노래를' },
};

const ko: EmailCopy = {
  signInCode: ({ siteName, otp }) => ({
    subject: `${siteName} 로그인 코드: ${otp}`,
    text: `${siteName} 로그인 코드는 ${otp}입니다. 10분 동안 유효합니다.`,
    html: `<p>${siteName} 로그인 코드는 <strong style="${codeStyle}">${otp}</strong>입니다.</p><p>10분 동안 유효합니다.</p>`,
  }),
  jobReady: ({ siteName, kind, resultURL, baseURL }) => {
    const { noun, subject } = koWhat[kind];
    return {
      subject: `${siteName}: ${subject} 완성됐어요`,
      text: `${subject} 완성됐어요: ${resultURL}\n\n로그인하면 지금까지 만든 결과를 ${baseURL}/ 에서 모두 볼 수 있어요.`,
      html: `<p>${subject} 완성됐어요.</p><p><a href="${resultURL}" style="${linkStyle}">${noun} 열기</a></p><p>로그인하면 지금까지 만든 결과를 <a href="${baseURL}/">${siteName}</a>에서 모두 볼 수 있어요.</p>`,
    };
  },
  jobFailed: ({ siteName, kind, costCredits, baseURL }) => {
    const { object } = koWhat[kind];
    const charge =
      costCredits > 0
        ? `요금은 청구되지 않았어요. 사용한 ${costCredits}크레딧은 계정으로 돌려드렸어요.`
        : `요금은 청구되지 않았어요.`;
    return {
      subject: `${siteName}: ${object} 만들지 못했어요`,
      text: `죄송해요. 이번에는 ${object} 만들지 못했어요. ${charge}\n\n${baseURL}/ 에서 다시 시도해 주세요.`,
      html: `<p>죄송해요. 이번에는 ${object} 만들지 못했어요.</p><p>${charge}</p><p><a href="${baseURL}/" style="${linkStyle}">${siteName}에서 다시 시도하기</a></p>`,
    };
  },
};

const copies: Record<string, EmailCopy> = { en, ja, ko };

/** Copy for a locale tag such as `ja` or `ko-KR`; unknown languages get English. */
export function emailCopy(locale: string): EmailCopy {
  return copies[locale.toLowerCase().split(/[-_]/)[0] ?? ''] ?? en;
}

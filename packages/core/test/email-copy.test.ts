import { describe, expect, it } from 'vitest';
import { emailCopy } from '../src/email/copy';

describe('email copy', () => {
  it('sends the sign-in code in the site language', () => {
    const ja = emailCopy('ja').signInCode({ siteName: 'AI作曲', otp: '782180' });
    expect(ja.subject).toBe('AI作曲のログインコード：782180');
    expect(ja.text).toBe('AI作曲のログインコードは 782180 です。10分間有効です。');
    expect(ja.html).toContain('<strong style="font-size:20px">782180</strong>');

    expect(emailCopy('ko-KR').signInCode({ siteName: 'AI 노래', otp: '123456' }).subject).toBe(
      'AI 노래 로그인 코드: 123456',
    );
  });

  it('keeps the English copy for English and unknown languages', () => {
    for (const locale of ['en', 'fr', '']) {
      expect(emailCopy(locale).signInCode({ siteName: 'Demo', otp: '111111' }).subject).toBe(
        '111111 is your Demo code',
      );
    }
  });

  it('names the result and the refund in Japanese', () => {
    const copy = emailCopy('ja');
    const input = { siteName: 'AI作曲', baseURL: 'https://x.test' };
    expect(copy.jobReady({ ...input, kind: 'video', resultURL: 'https://x.test/files/a.mp4' }).subject).toBe(
      'AI作曲：動画ができました',
    );
    expect(copy.jobFailed({ ...input, kind: 'image', costCredits: 0 }).text).toContain(
      '料金はかかっていません。',
    );
  });

  it('picks the right Korean particle for each result', () => {
    const copy = emailCopy('ko');
    const input = { siteName: 'AI 노래', baseURL: 'https://x.test' };
    expect(copy.jobReady({ ...input, kind: 'music', resultURL: 'https://x.test/files/a.mp3' }).subject).toBe(
      'AI 노래: 노래가 완성됐어요',
    );
    expect(copy.jobFailed({ ...input, kind: 'video', costCredits: 2 }).subject).toBe(
      'AI 노래: 영상을 만들지 못했어요',
    );
  });
});

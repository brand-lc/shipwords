import { describe, expect, it } from 'vitest';
import { isMp3, stripAudioTags } from '../src/audio-tags';
import { ascii, id3v2 } from './id3';

const id3v1 = (comment: string) => [...ascii('TAG'), ...ascii(comment.padEnd(125, '\0')).slice(0, 125)];
const FRAMES = [0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4];

describe('stripAudioTags', () => {
  it('drops leading ID3v2 tags (with or without a footer) and a trailing ID3v1 tag, keeping the frames', () => {
    const bytes = new Uint8Array([
      ...id3v2('made with vendor; id=1'),
      ...id3v2('second tag', true),
      ...FRAMES,
      ...id3v1('made with vendor'),
    ]);
    expect([...stripAudioTags(bytes)]).toEqual(FRAMES);
  });

  it('leaves untagged audio and malformed tags alone', () => {
    expect([...stripAudioTags(new Uint8Array(FRAMES))]).toEqual(FRAMES);
    const bad = new Uint8Array([...ascii('ID3'), 4, 0, 0, 0x80, 0, 0, 1, ...FRAMES]);
    expect(stripAudioTags(bad)).toBe(bad);
    // A footer flag without the "3DI" footer (or on v2.3, which has none) must not cut the first audio frame.
    for (const version of [4, 3]) {
      const tag = id3v2('made with vendor');
      tag[3] = version;
      tag[5] = 0x10;
      const flagged = new Uint8Array([...tag, ...FRAMES]);
      expect(stripAudioTags(flagged)).toBe(flagged);
    }
    // A tag that claims to run past the end must not empty the file.
    const overlong = new Uint8Array([...ascii('ID3'), 4, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f, ...FRAMES]);
    expect(stripAudioTags(overlong)).toBe(overlong);
  });

  it('only applies to MP3 media types', () => {
    expect(isMp3('audio/mpeg')).toBe(true);
    expect(isMp3('audio/mpeg; charset=binary')).toBe(true);
    expect(isMp3('audio/wav')).toBe(false);
    expect(isMp3('video/mp4')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { imageSize } from '../src/image-size';

function bytes(...parts: (number[] | string)[]): ArrayBuffer {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') out.push(...[...part].map((c) => c.charCodeAt(0)));
    else out.push(...part);
  }
  while (out.length < 40) out.push(0);
  return new Uint8Array(out).buffer;
}
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];

describe('imageSize', () => {
  it('reads PNG IHDR', () => {
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32(13), 'IHDR', u32(116), u32(160));
    expect(imageSize(png)).toEqual({ width: 116, height: 160 });
  });

  it('skips JPEG segments to the SOF marker', () => {
    const app0 = [
      0xff,
      0xe0,
      ...u16(16),
      ...'JFIF'.split('').map((c) => c.charCodeAt(0)),
      0,
      1,
      1,
      0,
      0,
      1,
      0,
      1,
      0,
      0,
    ];
    const sof2 = [0xff, 0xc2, ...u16(17), 8, ...u16(195), ...u16(260), 3];
    expect(imageSize(bytes([0xff, 0xd8], app0, sof2))).toEqual({ width: 260, height: 195 });
  });

  it('does not mistake a DHT segment for a frame header', () => {
    const dht = [0xff, 0xc4, ...u16(5), 0, 0, 0];
    const sof0 = [0xff, 0xc0, ...u16(17), 8, ...u16(1024), ...u16(768), 3];
    expect(imageSize(bytes([0xff, 0xd8], dht, sof0))).toEqual({ width: 768, height: 1024 });
  });

  it('reads the three WebP variants', () => {
    const riff = (chunk: string, body: number[]) =>
      bytes('RIFF', [0, 0, 0, 0], 'WEBP', chunk, [0, 0, 0, 0], body);
    // VP8: 3-byte frame tag, start code, then 14-bit little-endian width and height.
    expect(imageSize(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(640), ...le16(480)]))).toEqual({
      width: 640,
      height: 480,
    });
    // VP8L: signature byte, then width-1 and height-1 packed into 14 bits each.
    const bits = (300 - 1) | ((200 - 1) << 14);
    expect(
      imageSize(riff('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, bits >>> 24])),
    ).toEqual({
      width: 300,
      height: 200,
    });
    // VP8X: flags and reserved bytes, then 24-bit width-1 and height-1.
    expect(imageSize(riff('VP8X', [0, 0, 0, 0, 1999 & 0xff, 1999 >> 8, 0, 99, 0, 0]))).toEqual({
      width: 2000,
      height: 100,
    });
  });

  it('returns null for anything else', () => {
    expect(imageSize(bytes('GIF89a'))).toBeNull();
    expect(imageSize(new ArrayBuffer(4))).toBeNull();
  });
});

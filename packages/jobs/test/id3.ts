// Test helpers: hand-built ID3 tags like the ones upstream encoders write.

export const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** An ID3v2.4 tag holding one comment, sized with a syncsafe length like real encoders write it. */
export function id3v2(comment: string, footer = false): number[] {
  const body = [...ascii('COMM'), 0, 0, 0, comment.length, 0, 0, ...ascii(comment)];
  const size = body.length;
  const syncsafe = [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];
  const header = [...ascii('ID3'), 4, 0, footer ? 0x10 : 0, ...syncsafe];
  return [...header, ...body, ...(footer ? [...ascii('3DI'), 4, 0, 0x10, ...syncsafe] : [])];
}

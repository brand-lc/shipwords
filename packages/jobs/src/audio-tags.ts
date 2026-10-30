// Upstream MP3s carry ID3 tags written by the provider (comments such as "made with <vendor>", creation times, job IDs).
// Outputs are served as the site's own files, so the tags are dropped before storing; the audio frames are left untouched.

const ID3V2_HEADER = 10;
const ID3V1_SIZE = 128;

/** ID3v2 sizes are "syncsafe": 4 bytes of 7 bits each. Returns null when a byte has its high bit set (not a valid tag). */
function syncsafe(bytes: Uint8Array, at: number): number | null {
  let size = 0;
  for (let i = 0; i < 4; i++) {
    const byte = bytes[at + i]!;
    if (byte & 0x80) return null;
    size = (size << 7) | byte;
  }
  return size;
}

const isAt = (bytes: Uint8Array, at: number, text: string) =>
  [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));

/** MP3 bytes without leading ID3v2 tags and a trailing ID3v1 tag. Anything that does not parse as a tag is returned unchanged. */
export function stripAudioTags(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (bytes.length - start >= ID3V2_HEADER && isAt(bytes, start, 'ID3')) {
    const size = syncsafe(bytes, start + 6);
    if (size === null) break;
    const footer = bytes[start + 5]! & 0x10 ? ID3V2_HEADER : 0;
    start += ID3V2_HEADER + size + footer;
  }
  let end = bytes.length;
  if (end - start >= ID3V1_SIZE && isAt(bytes, end - ID3V1_SIZE, 'TAG')) end -= ID3V1_SIZE;
  if (start >= end || (start === 0 && end === bytes.length)) return bytes;
  return bytes.subarray(start, end);
}

export const isMp3 = (mediaType: string) => /^audio\/(mpeg|mp3)\b/i.test(mediaType);

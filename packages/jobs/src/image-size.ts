// Reads width and height from PNG, JPEG and WebP headers without decoding pixels (Workers have no image decoder).

export interface ImageSize {
  width: number;
  height: number;
}

export function imageSize(buffer: ArrayBuffer): ImageSize | null {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 24) return null;
  // PNG: signature, then the IHDR chunk holds width and height.
  if (view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG: walk the segments to the first SOF marker.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      // Standalone markers carry no length.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        offset += 2;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      offset += 2 + view.getUint16(offset + 2);
    }
    return null;
  }
  // WebP: RIFF container with a VP8, VP8L or VP8X chunk first.
  if (view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250 && bytes.length >= 30) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === 'VP8 ') {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
      const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
      return { width, height };
    }
  }
  return null;
}

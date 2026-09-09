/**
 * Dependency-free image helpers: signature sniffing, dimension parsing and
 * metadata (EXIF/XMP/IPTC/text) stripping for JPEG, PNG and WebP.
 */

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export const IMAGE_MIMES: readonly ImageMime[] = ['image/jpeg', 'image/png', 'image/webp'];

export const IMAGE_EXT: Record<ImageMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function sniffImageMime(buf: Buffer): ImageMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export interface Dimensions {
  width: number;
  height: number;
}

export function readDimensions(buf: Buffer, mime: ImageMime): Dimensions | null {
  switch (mime) {
    case 'image/jpeg':
      return jpegDimensions(buf);
    case 'image/png':
      return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
    case 'image/webp':
      return webpDimensions(buf);
  }
}

function jpegDimensions(buf: Buffer): Dimensions | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xda) return null; // start of scan without SOF
    i += 2 + len;
  }
  return null;
}

function webpDimensions(buf: Buffer): Dimensions | null {
  if (buf.length < 30) return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const b0 = buf[21]!, b1 = buf[22]!, b2 = buf[23]!, b3 = buf[24]!;
    return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  if (chunk === 'VP8X') {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  return null;
}

/** Removes EXIF/XMP/ICC-less metadata segments. Pixel data is untouched. */
export function stripImageMetadata(buf: Buffer, mime: ImageMime): Buffer {
  switch (mime) {
    case 'image/jpeg':
      return stripJpeg(buf);
    case 'image/png':
      return stripPng(buf);
    case 'image/webp':
      return stripWebp(buf);
  }
}

function stripJpeg(buf: Buffer): Buffer {
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1]!;
    if (marker === 0xda) {
      parts.push(buf.subarray(i));
      return Buffer.concat(parts);
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    const end = i + 2 + len;
    // APP1 (EXIF/XMP), APP13 (IPTC/Photoshop), COM (comments)
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) parts.push(buf.subarray(i, end));
    i = end;
  }
  parts.push(buf.subarray(i));
  return Buffer.concat(parts);
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

function stripPng(buf: Buffer): Buffer {
  const parts: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const end = i + 12 + len;
    if (!PNG_DROP.has(type)) parts.push(buf.subarray(i, Math.min(end, buf.length)));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(parts);
}

const WEBP_DROP = new Set(['EXIF', 'XMP ']);

function stripWebp(buf: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let i = 12;
  let vp8xIndex = -1;
  while (i + 8 <= buf.length) {
    const type = buf.toString('ascii', i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const padded = len + (len % 2);
    const end = Math.min(i + 8 + padded, buf.length);
    if (!WEBP_DROP.has(type)) {
      const chunk = Buffer.from(buf.subarray(i, end));
      if (type === 'VP8X') vp8xIndex = chunks.length;
      chunks.push(chunk);
    }
    i = end;
  }
  if (vp8xIndex >= 0) {
    // clear EXIF (bit 3) and XMP (bit 2) flags
    const flags = chunks[vp8xIndex]!;
    flags[8] = flags[8]! & ~0x0c;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
}

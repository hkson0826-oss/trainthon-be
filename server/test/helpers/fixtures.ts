import { deflateSync } from 'node:zlib';

/** Minimal baseline JPEG (1x1) with an APP1 EXIF segment injected after SOI. */
export function jpegWithExif(width = 1, height = 1): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const exifPayload = Buffer.from('Exif\0\0FAKE-GPS-DATA', 'ascii');
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16(exifPayload.length + 2), exifPayload]);
  // SOF0: length 11 (for 1 component), precision 8, height, width, components 1, comp spec
  const sof0 = Buffer.concat([Buffer.from([0xff, 0xc0]), u16(11), Buffer.from([8]), u16(height), u16(width), Buffer.from([1, 1, 0x11, 0])]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app1, sof0, sos, eoi]);
}

/** Minimal PNG (1x1 RGBA) with a tEXt chunk. */
export function pngWithText(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = chunk('IHDR', Buffer.concat([u32(1), u32(1), Buffer.from([8, 6, 0, 0, 0])]));
  const text = chunk('tEXt', Buffer.from('Comment\0secret', 'latin1'));
  const idat = chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0])));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, text, idat, iend]);
}

export function notAnImage(): Buffer {
  return Buffer.from('%PDF-1.4 definitely not an image');
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}
function chunk(type: string, data: Buffer): Buffer {
  return Buffer.concat([u32(data.length), Buffer.from(type, 'ascii'), data, u32(0)]);
}

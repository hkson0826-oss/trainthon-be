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

/**
 * Minimal MP4 container: ftyp + moov(mvhd, trak(tkhd)) + mdat padding.
 * Not decodable, but carries real duration/dimension metadata for header probing.
 */
export function fakeMp4(opts: { durationSec?: number; width?: number; height?: number; padBytes?: number; mvhdV1?: boolean } = {}): Buffer {
  const { durationSec = 20, width = 1920, height = 1080, padBytes = 4096, mvhdV1 = false } = opts;
  const timescale = 1000;
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom', 'ascii'), u32(0x200), Buffer.from('isomiso2mp41', 'ascii')]));
  let mvhd: Buffer;
  if (mvhdV1) {
    mvhd = box('mvhd', Buffer.concat([Buffer.from([1, 0, 0, 0]), u64(0), u64(0), u32(timescale), u64(Math.round(durationSec * timescale)), Buffer.alloc(80)]));
  } else {
    mvhd = box('mvhd', Buffer.concat([Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(timescale), u32(Math.round(durationSec * timescale)), Buffer.alloc(80)]));
  }
  // tkhd v0: version/flags(4) ctime(4) mtime(4) track_id(4) reserved(4) duration(4) reserved(8) layer(2) alt(2) volume(2) reserved(2) matrix(36) width(4) height(4)
  const tkhd = box('tkhd', Buffer.concat([Buffer.alloc(76), u32(width * 65536), u32(height * 65536)]));
  const trak = box('trak', tkhd);
  const moov = box('moov', Buffer.concat([mvhd, trak]));
  const mdat = box('mdat', Buffer.alloc(padBytes, 0xab));
  return Buffer.concat([ftyp, moov, mdat]);
}

export function notAVideo(size = 1024): Buffer {
  return Buffer.concat([Buffer.from('RIFF....AVI LIST', 'ascii'), Buffer.alloc(Math.max(0, size - 16))]);
}

function box(type: string, payload: Buffer): Buffer {
  return Buffer.concat([u32(payload.length + 8), Buffer.from(type, 'ascii'), payload]);
}
function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
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

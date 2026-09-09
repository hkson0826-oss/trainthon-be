/**
 * Minimal ISO BMFF (MP4) inspection: signature check plus duration and
 * dimensions read from moov/mvhd and moov/trak/tkhd. No decoding.
 */

export interface Mp4Info {
  durationSec: number | null;
  width: number | null;
  height: number | null;
}

/** True when the buffer starts with an ISO BMFF `ftyp` box (any brand). */
export function isMp4(buf: Buffer): boolean {
  return buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp';
}

interface Box {
  type: string;
  start: number; // payload start
  end: number; // box end (exclusive)
}

function* boxes(buf: Buffer, from: number, to: number): Generator<Box> {
  let i = from;
  while (i + 8 <= to) {
    let size = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    let header = 8;
    if (size === 1) {
      if (i + 16 > to) return;
      const big = buf.readBigUInt64BE(i + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return;
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = to - i;
    }
    if (size < header) return;
    const end = Math.min(i + size, to);
    yield { type, start: i + header, end };
    i += size;
  }
}

export function readMp4Info(buf: Buffer): Mp4Info {
  const info: Mp4Info = { durationSec: null, width: null, height: null };
  if (!isMp4(buf)) return info;
  for (const top of boxes(buf, 0, buf.length)) {
    if (top.type !== 'moov') continue;
    for (const b of boxes(buf, top.start, top.end)) {
      if (b.type === 'mvhd') {
        const version = buf[b.start];
        if (version === 1 && b.start + 32 <= b.end) {
          const timescale = buf.readUInt32BE(b.start + 20);
          const duration = Number(buf.readBigUInt64BE(b.start + 24));
          if (timescale > 0) info.durationSec = duration / timescale;
        } else if (b.start + 20 <= b.end) {
          const timescale = buf.readUInt32BE(b.start + 12);
          const duration = buf.readUInt32BE(b.start + 16);
          if (timescale > 0) info.durationSec = duration / timescale;
        }
      } else if (b.type === 'trak') {
        for (const t of boxes(buf, b.start, b.end)) {
          if (t.type !== 'tkhd') continue;
          const version = buf[t.start];
          const off = version === 1 ? t.start + 88 : t.start + 76;
          if (off + 8 <= t.end) {
            const w = buf.readUInt32BE(off) / 65536;
            const h = buf.readUInt32BE(off + 4) / 65536;
            if (w > 0 && h > 0 && info.width === null) {
              info.width = Math.round(w);
              info.height = Math.round(h);
            }
          }
        }
      }
    }
  }
  return info;
}

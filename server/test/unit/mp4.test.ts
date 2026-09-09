import { describe, expect, it } from 'vitest';
import { isMp4, readMp4Info } from '../../src/lib/mp4.js';
import { fakeMp4, notAVideo } from '../helpers/fixtures.js';

describe('mp4 header probe', () => {
  it('detects ftyp signature', () => {
    expect(isMp4(fakeMp4())).toBe(true);
    expect(isMp4(notAVideo())).toBe(false);
    expect(isMp4(Buffer.alloc(3))).toBe(false);
  });

  it('reads duration and dimensions (mvhd v0)', () => {
    expect(readMp4Info(fakeMp4({ durationSec: 20.5, width: 1280, height: 720 }))).toEqual({ durationSec: 20.5, width: 1280, height: 720 });
  });

  it('reads duration from mvhd v1 (64-bit)', () => {
    expect(readMp4Info(fakeMp4({ durationSec: 3600, mvhdV1: true })).durationSec).toBe(3600);
  });

  it('returns nulls for non-mp4 or truncated input', () => {
    expect(readMp4Info(notAVideo())).toEqual({ durationSec: null, width: null, height: null });
    expect(readMp4Info(fakeMp4().subarray(0, 30))).toEqual({ durationSec: null, width: null, height: null });
  });
});

import { describe, expect, it } from 'vitest';
import { readDimensions, sniffImageMime, stripImageMetadata } from '../../src/lib/images.js';
import { jpegWithExif, notAnImage, pngWithText } from '../helpers/fixtures.js';

describe('images', () => {
  it('sniffs JPEG/PNG and rejects other content', () => {
    expect(sniffImageMime(jpegWithExif())).toBe('image/jpeg');
    expect(sniffImageMime(pngWithText())).toBe('image/png');
    expect(sniffImageMime(notAnImage())).toBeNull();
  });

  it('reads dimensions', () => {
    expect(readDimensions(jpegWithExif(640, 480), 'image/jpeg')).toEqual({ width: 640, height: 480 });
    expect(readDimensions(pngWithText(), 'image/png')).toEqual({ width: 1, height: 1 });
  });

  it('strips EXIF from JPEG and text chunks from PNG while keeping the image decodable structure', () => {
    const jpeg = jpegWithExif();
    expect(jpeg.includes(Buffer.from('FAKE-GPS-DATA'))).toBe(true);
    const cleanJpeg = stripImageMetadata(jpeg, 'image/jpeg');
    expect(cleanJpeg.includes(Buffer.from('FAKE-GPS-DATA'))).toBe(false);
    expect(sniffImageMime(cleanJpeg)).toBe('image/jpeg');
    expect(readDimensions(cleanJpeg, 'image/jpeg')).toEqual({ width: 1, height: 1 });
    expect(cleanJpeg.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));

    const png = pngWithText();
    expect(png.includes(Buffer.from('secret'))).toBe(true);
    const cleanPng = stripImageMetadata(png, 'image/png');
    expect(cleanPng.includes(Buffer.from('secret'))).toBe(false);
    expect(cleanPng.includes(Buffer.from('IHDR'))).toBe(true);
    expect(cleanPng.includes(Buffer.from('IEND'))).toBe(true);
  });
});

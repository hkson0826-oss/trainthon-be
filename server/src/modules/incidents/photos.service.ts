import { createHash, randomUUID } from 'node:crypto';
import type { StorageAdapter } from '../../adapters/storage/index.js';
import type { Env } from '../../config/env.js';
import { ApiError } from '../../lib/errors.js';
import { IMAGE_EXT, IMAGE_MIMES, readDimensions, sniffImageMime, stripImageMetadata, type ImageMime } from '../../lib/images.js';

export const MAX_PHOTO_PIXELS = 40_000_000;

export interface PhotoDeps {
  env: Env;
  storage: StorageAdapter;
}

export function stagingPrefix(userId: string): string {
  return `staging/${userId}/`;
}

export function isImageMime(mime: string): mime is ImageMime {
  return (IMAGE_MIMES as readonly string[]).includes(mime);
}

/** F3: issues a signed upload URL under the requester's staging area. */
export async function createPhotoUploadUrl(deps: PhotoDeps, userId: string, mime: string, bytes: number) {
  if (!isImageMime(mime)) throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Photos must be JPEG, PNG or WebP');
  if (bytes <= 0) throw ApiError.validation('bytes must be positive', { bytes: 'positive' });
  if (bytes > deps.env.MAX_PHOTO_BYTES) throw new ApiError('FILE_TOO_LARGE', `Photo exceeds ${deps.env.MAX_PHOTO_BYTES} bytes`);
  const objectPath = `${stagingPrefix(userId)}${randomUUID()}.${IMAGE_EXT[mime]}`;
  const signed = await deps.storage.createSignedUploadUrl(deps.env.SUPABASE_BUCKET_PHOTOS, objectPath, deps.env.UPLOAD_SIGNED_URL_TTL_SEC);
  return {
    objectPath,
    uploadUrl: signed.signedUrl,
    token: signed.token,
    expiresAt: signed.expiresAt.toISOString(),
  };
}

export interface SweepResult {
  scanned: number;
  removed: string[];
}

/**
 * Deletes staged photo uploads that were never attached to an incident. Objects under
 * `staging/` older than STAGING_RETENTION_HOURS are removed (attach moves objects out of
 * staging, so anything still there past the window is abandoned). Safe to run repeatedly.
 */
export async function sweepStagingUploads(deps: PhotoDeps, now = new Date()): Promise<SweepResult> {
  const { env, storage } = deps;
  const cutoff = now.getTime() - env.STAGING_RETENTION_HOURS * 60 * 60 * 1000;
  const objects = await storage.listObjects(env.SUPABASE_BUCKET_PHOTOS, 'staging/');
  const stale = objects.filter((o) => o.path.startsWith('staging/') && o.lastModified !== null && o.lastModified.getTime() < cutoff).map((o) => o.path);
  for (let i = 0; i < stale.length; i += 100) await storage.remove(env.SUPABASE_BUCKET_PHOTOS, stale.slice(i, i + 100));
  return { scanned: objects.length, removed: stale };
}

export interface ProcessedPhoto {
  objectPath: string;
  mime: ImageMime;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  position: number;
}

/**
 * Validates staged photos (ownership, existence, signature, size, pixels),
 * strips metadata and moves them to the incident's final path.
 * Returns processed rows; caller persists them. Throws ApiError on any invalid input.
 */
export async function attachStagedPhotos(deps: PhotoDeps, userId: string, incidentId: string, stagedPaths: string[]): Promise<ProcessedPhoto[]> {
  const { env, storage } = deps;
  const bucket = env.SUPABASE_BUCKET_PHOTOS;
  if (stagedPaths.length > env.MAX_PHOTO_COUNT) {
    throw ApiError.validation(`At most ${env.MAX_PHOTO_COUNT} photos`, { photoObjectPaths: 'too_many' });
  }
  if (new Set(stagedPaths).size !== stagedPaths.length) throw ApiError.validation('Duplicate photo paths', { photoObjectPaths: 'duplicate' });

  const prefix = stagingPrefix(userId);
  const processed: ProcessedPhoto[] = [];
  const written: string[] = [];
  try {
    for (const [position, stagedPath] of stagedPaths.entries()) {
      if (!stagedPath.startsWith(prefix) || stagedPath.includes('..')) {
        throw ApiError.validation('Photo path is not in your staging area', { [`photoObjectPaths.${position}`]: 'not_owned' });
      }
      const info = await storage.getObjectInfo(bucket, stagedPath);
      if (!info) throw ApiError.validation('Staged photo not found', { [`photoObjectPaths.${position}`]: 'not_found' });
      if (info.size > env.MAX_PHOTO_BYTES) throw new ApiError('FILE_TOO_LARGE', `Photo exceeds ${env.MAX_PHOTO_BYTES} bytes`);

      const raw = await storage.download(bucket, stagedPath);
      if (raw.length > env.MAX_PHOTO_BYTES) throw new ApiError('FILE_TOO_LARGE', `Photo exceeds ${env.MAX_PHOTO_BYTES} bytes`);
      const mime = sniffImageMime(raw);
      if (!mime) throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'File content is not a JPEG, PNG or WebP image');
      const dims = readDimensions(raw, mime);
      if (dims && dims.width * dims.height > MAX_PHOTO_PIXELS) {
        throw ApiError.validation('Image dimensions too large', { [`photoObjectPaths.${position}`]: 'too_many_pixels' });
      }
      const clean = stripImageMetadata(raw, mime);
      const finalPath = `incidents/${incidentId}/${position}.${IMAGE_EXT[mime]}`;
      await storage.upload(bucket, finalPath, clean, mime);
      written.push(finalPath);
      processed.push({
        objectPath: finalPath,
        mime,
        bytes: clean.length,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        sha256: createHash('sha256').update(clean).digest('hex'),
        position,
      });
    }
  } catch (err) {
    await storage.remove(bucket, written).catch(() => undefined);
    throw err;
  }
  await storage.remove(bucket, stagedPaths).catch(() => undefined);
  return processed;
}

export async function removeIncidentPhotos(deps: PhotoDeps, paths: string[]): Promise<void> {
  await deps.storage.remove(deps.env.SUPABASE_BUCKET_PHOTOS, paths).catch(() => undefined);
}

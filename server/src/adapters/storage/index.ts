import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface ObjectInfo {
  size: number;
  contentType: string | null;
  lastModified: Date | null;
}

export interface SignedUpload {
  signedUrl: string;
  token: string;
  path: string;
  /** Actual expiry enforced by the storage provider (may be longer than the requested TTL). */
  expiresAt: Date;
}

export interface StoredObject {
  path: string;
  size: number;
  lastModified: Date | null;
}

export interface StorageAdapter {
  /**
   * Issues a one-shot upload URL. `ttlSec` is a request; providers with a fixed lifetime
   * (Supabase: 2h) report the real one in `expiresAt`, which callers must surface as-is.
   */
  createSignedUploadUrl(bucket: string, path: string, ttlSec: number): Promise<SignedUpload>;
  createSignedUrl(bucket: string, path: string, ttlSec: number): Promise<string>;
  getObjectInfo(bucket: string, path: string): Promise<ObjectInfo | null>;
  download(bucket: string, path: string): Promise<Buffer>;
  upload(bucket: string, path: string, data: Buffer, contentType: string): Promise<void>;
  remove(bucket: string, paths: string[]): Promise<void>;
  /** Non-recursive listing of direct children (files and folders as paths). */
  list(bucket: string, prefix: string): Promise<string[]>;
  /** Recursive listing of all objects under `prefix` with modification times. */
  listObjects(bucket: string, prefix: string): Promise<StoredObject[]>;
}

/** Supabase signed upload URLs have a fixed 2-hour validity that cannot be shortened via the API. */
export const SUPABASE_SIGNED_UPLOAD_TTL_SEC = 2 * 60 * 60;

export class StorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'StorageError';
  }
}

/* ------------------------------------------------------------------ */
/* Supabase Storage                                                    */
/* ------------------------------------------------------------------ */

export class SupabaseStorageAdapter implements StorageAdapter {
  private readonly client: SupabaseClient;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.client = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  }

  async createSignedUploadUrl(bucket: string, path: string, _ttlSec: number): Promise<SignedUpload> {
    const issuedAt = Date.now();
    const { data, error } = await this.client.storage.from(bucket).createSignedUploadUrl(path);
    if (error || !data) throw new StorageError(`createSignedUploadUrl failed: ${error?.message ?? 'no data'}`, error);
    return { signedUrl: data.signedUrl, token: data.token, path: data.path, expiresAt: new Date(issuedAt + SUPABASE_SIGNED_UPLOAD_TTL_SEC * 1000) };
  }

  async createSignedUrl(bucket: string, path: string, ttlSec: number): Promise<string> {
    const { data, error } = await this.client.storage.from(bucket).createSignedUrl(path, ttlSec);
    if (error || !data) throw new StorageError(`createSignedUrl failed: ${error?.message ?? 'no data'}`, error);
    return data.signedUrl;
  }

  async getObjectInfo(bucket: string, path: string): Promise<ObjectInfo | null> {
    const idx = path.lastIndexOf('/');
    const dir = idx >= 0 ? path.slice(0, idx) : '';
    const name = idx >= 0 ? path.slice(idx + 1) : path;
    const { data, error } = await this.client.storage.from(bucket).list(dir, { search: name, limit: 100 });
    if (error) throw new StorageError(`list failed: ${error.message}`, error);
    const hit = data?.find((o) => o.name === name);
    if (!hit) return null;
    const meta = (hit.metadata ?? {}) as { size?: number; mimetype?: string; contentLength?: number };
    return {
      size: Number(meta.size ?? meta.contentLength ?? 0),
      contentType: meta.mimetype ?? null,
      lastModified: hit.updated_at ? new Date(hit.updated_at) : null,
    };
  }

  async download(bucket: string, path: string): Promise<Buffer> {
    const { data, error } = await this.client.storage.from(bucket).download(path);
    if (error || !data) throw new StorageError(`download failed: ${error?.message ?? 'no data'}`, error);
    return Buffer.from(await data.arrayBuffer());
  }

  async upload(bucket: string, path: string, data: Buffer, contentType: string): Promise<void> {
    const { error } = await this.client.storage.from(bucket).upload(path, data, { contentType, upsert: true });
    if (error) throw new StorageError(`upload failed: ${error.message}`, error);
  }

  async remove(bucket: string, paths: string[]): Promise<void> {
    if (!paths.length) return;
    const { error } = await this.client.storage.from(bucket).remove(paths);
    if (error) throw new StorageError(`remove failed: ${error.message}`, error);
  }

  async list(bucket: string, prefix: string): Promise<string[]> {
    const { data, error } = await this.client.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error) throw new StorageError(`list failed: ${error.message}`, error);
    return (data ?? []).map((o) => (prefix ? `${prefix}/${o.name}` : o.name));
  }

  async listObjects(bucket: string, prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    const walk = async (dir: string): Promise<void> => {
      let offset = 0;
      for (;;) {
        const { data, error } = await this.client.storage.from(bucket).list(dir, { limit: 1000, offset });
        if (error) throw new StorageError(`list failed: ${error.message}`, error);
        const page = data ?? [];
        for (const o of page) {
          const path = dir ? `${dir}/${o.name}` : o.name;
          // Supabase returns folders as entries without an id/metadata.
          if (o.id === null || o.id === undefined) {
            await walk(path);
            continue;
          }
          const meta = (o.metadata ?? {}) as { size?: number; contentLength?: number };
          out.push({ path, size: Number(meta.size ?? meta.contentLength ?? 0), lastModified: o.updated_at ? new Date(o.updated_at) : null });
        }
        if (page.length < 1000) break;
        offset += page.length;
      }
    };
    await walk(prefix.replace(/\/+$/, ''));
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* In-memory (tests)                                                   */
/* ------------------------------------------------------------------ */

interface MemObject {
  data: Buffer;
  contentType: string;
  updatedAt: Date;
}

export class MemoryStorageAdapter implements StorageAdapter {
  readonly objects = new Map<string, MemObject>();
  readonly signedUploads = new Map<string, { bucket: string; path: string }>();
  readonly signedUrlLog: Array<{ bucket: string; path: string; ttlSec: number }> = [];

  private key(bucket: string, path: string): string {
    return `${bucket}/${path}`;
  }

  /** Test helper simulating a client PUT to a signed upload URL. */
  put(bucket: string, path: string, data: Buffer, contentType: string, updatedAt = new Date()): void {
    this.objects.set(this.key(bucket, path), { data, contentType, updatedAt });
  }

  async createSignedUploadUrl(bucket: string, path: string, ttlSec: number): Promise<SignedUpload> {
    const token = `upload-token-${this.signedUploads.size + 1}`;
    this.signedUploads.set(token, { bucket, path });
    return { signedUrl: `memory://upload/${bucket}/${path}?token=${token}`, token, path, expiresAt: new Date(Date.now() + ttlSec * 1000) };
  }

  async createSignedUrl(bucket: string, path: string, ttlSec: number): Promise<string> {
    if (!this.objects.has(this.key(bucket, path))) throw new StorageError('object not found');
    this.signedUrlLog.push({ bucket, path, ttlSec });
    return `memory://signed/${bucket}/${path}?ttl=${ttlSec}`;
  }

  async getObjectInfo(bucket: string, path: string): Promise<ObjectInfo | null> {
    const o = this.objects.get(this.key(bucket, path));
    return o ? { size: o.data.length, contentType: o.contentType, lastModified: o.updatedAt } : null;
  }

  async download(bucket: string, path: string): Promise<Buffer> {
    const o = this.objects.get(this.key(bucket, path));
    if (!o) throw new StorageError('object not found');
    return o.data;
  }

  async upload(bucket: string, path: string, data: Buffer, contentType: string): Promise<void> {
    this.put(bucket, path, data, contentType);
  }

  async remove(bucket: string, paths: string[]): Promise<void> {
    for (const p of paths) this.objects.delete(this.key(bucket, p));
  }

  async list(bucket: string, prefix: string): Promise<string[]> {
    const pre = `${bucket}/${prefix}`;
    return [...this.objects.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(bucket.length + 1));
  }

  async listObjects(bucket: string, prefix: string): Promise<StoredObject[]> {
    const pre = `${bucket}/${prefix}`;
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(pre))
      .map(([k, o]) => ({ path: k.slice(bucket.length + 1), size: o.data.length, lastModified: o.updatedAt }));
  }
}

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Mp4Info } from './mp4.js';

const execFileAsync = promisify(execFile);

/** Optional ffprobe-backed probe (VIDEO_PROBE_ENABLED). Returns null when ffprobe is unavailable or fails. */
export async function ffprobeInfo(data: Buffer, ffprobePath = 'ffprobe'): Promise<Mp4Info | null> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lumina-probe-'));
  const file = path.join(dir, 'video.mp4');
  try {
    await writeFile(file, data);
    const { stdout } = await execFileAsync(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type', '-of', 'json', file],
      { timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ width?: number; height?: number; codec_type?: string }> };
    const video = parsed.streams?.find((s) => s.codec_type === 'video');
    const duration = parsed.format?.duration ? Number(parsed.format.duration) : NaN;
    return {
      durationSec: Number.isFinite(duration) ? duration : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
    };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

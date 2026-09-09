import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { analysisResultSchema, type AnalysisResult } from '../../adapters/twelvelabs/schema.js';

const fixtureSchema = z.object({
  videoFileName: z.string().optional(),
  videoSha256: z.string().regex(/^[0-9a-f]{64}$/i, 'videoSha256 must be a 64-hex sha256'),
  provider: z.string().default('twelvelabs'),
  model: z.string().default('pegasus1.5'),
  promptVersion: z.string().default('v1'),
  analyzedAt: z.string().optional(),
  rawResponse: z.unknown().optional(),
  result: analysisResultSchema,
});

export type PrerecordedFixture = z.infer<typeof fixtureSchema> & { file: string };

export interface PrerecordedStore {
  findBySha256(sha256: string): PrerecordedFixture | null;
  size(): number;
}

export interface LoadReport {
  loaded: PrerecordedFixture[];
  skipped: Array<{ file: string; reason: string }>;
}

/**
 * Loads `*.json` fixtures from a directory. Files that fail validation (e.g. a placeholder
 * `videoSha256`) are skipped and reported rather than throwing, so a half-filled fixture never
 * breaks server startup. `*.example.json` files are ignored.
 */
export async function loadPrerecordedFixtures(dir: string): Promise<LoadReport> {
  const report: LoadReport = { loaded: [], skipped: [] };
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return report;
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.endsWith('.example.json')) continue;
    const file = path.join(dir, name);
    try {
      const json: unknown = JSON.parse(await readFile(file, 'utf8'));
      const parsed = fixtureSchema.safeParse(json);
      if (!parsed.success) {
        report.skipped.push({ file, reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
        continue;
      }
      report.loaded.push({ ...parsed.data, videoSha256: parsed.data.videoSha256.toLowerCase(), file });
    } catch (err) {
      report.skipped.push({ file, reason: err instanceof Error ? err.message : 'unreadable' });
    }
  }
  return report;
}

export class InMemoryPrerecordedStore implements PrerecordedStore {
  private readonly bySha = new Map<string, PrerecordedFixture>();

  constructor(fixtures: PrerecordedFixture[] = []) {
    for (const f of fixtures) this.bySha.set(f.videoSha256.toLowerCase(), f);
  }

  findBySha256(sha256: string): PrerecordedFixture | null {
    return this.bySha.get(sha256.toLowerCase()) ?? null;
  }

  size(): number {
    return this.bySha.size;
  }
}

/** Fixed result used by the fake provider when no fixture matches (never claims a detection). */
export const NO_DETECTION_RESULT: Omit<AnalysisResult, 'videoDurationSec' | 'disclaimer'> = {
  incidentDetected: false,
  incidentTimestampSeconds: null,
  incidentTimestampLabel: null,
  victimVehicle: '식별되지 않음',
  otherVehicle: null,
  event: '사고 후보 장면을 찾지 못했습니다.',
  relevance: 'LOW',
  evidence: ['요청 정보와 일치하는 장면이 관찰되지 않음'],
};

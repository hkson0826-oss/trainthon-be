import {
  buildAnalyzeRequest,
  hashAnalyzeRequest,
  ProviderError,
  type AnalyzeClient,
  type AnalyzeResponse,
  type MediaSource,
  type VideoSource,
} from '../../adapters/twelvelabs/client.js';
import { buildPromptV1, type PromptIncident } from '../../adapters/twelvelabs/prompt.js';
import { providerResultSchema, type ProviderResult } from '../../adapters/twelvelabs/schema.js';
import type { Env } from '../../config/env.js';
import type { PrerecordedStore } from './prerecorded.js';

export type AnalysisSource = 'LIVE' | 'PRERECORDED';

export interface AnalysisInput {
  submission: { id: string; sha256: string; bytes: number; durationSec: number | null };
  incident: PromptIncident;
  /** Signed URL of the original video, valid for at least the analysis timeout. */
  videoUrl: string;
  /** Lazily downloads the video for the base64 fallback. */
  loadVideo: () => Promise<Buffer>;
  /** Signed URLs of the requester's victim-vehicle photos (max 4 used). */
  photoUrls: string[];
}

export interface ProviderOutcome {
  source: AnalysisSource;
  raw: unknown;
  parsed: ProviderResult;
  requestHash: string | null;
  promptVersion: string;
  model: string;
}

export interface AnalysisProvider {
  readonly kind: 'live' | 'fake';
  analyze(input: AnalysisInput, timeoutMs: number): Promise<ProviderOutcome>;
}

const MAX_MEDIA_SOURCES = 4;

/** AI_MODE=live: real TwelveLabs Analyze call; URL first, base64 once as fallback (BE_SPEC F6 step 3). */
export class LiveTwelveLabsProvider implements AnalysisProvider {
  readonly kind = 'live' as const;

  constructor(
    private readonly client: AnalyzeClient,
    private readonly env: Env,
  ) {}

  async analyze(input: AnalysisInput, timeoutMs: number): Promise<ProviderOutcome> {
    const photoUrls = this.env.ANALYSIS_USE_REFERENCE_IMAGES ? input.photoUrls.slice(0, MAX_MEDIA_SOURCES) : [];
    const promptText = buildPromptV1(input.incident, photoUrls.length, this.env.DEMO_TIMEZONE);
    const mediaSources: MediaSource[] = photoUrls.map((url, i) => ({ name: `victim-photo-${i + 1}`, media_type: 'image', url }));
    const base64Eligible = input.submission.bytes > 0 && input.submission.bytes <= this.env.TWELVELABS_BASE64_MAX_BYTES;

    const attempt = async (video: VideoSource) => {
      const req = buildAnalyzeRequest({
        model: this.env.TWELVELABS_MODEL,
        video,
        promptText,
        mediaSources,
        temperature: this.env.ANALYSIS_TEMPERATURE,
        maxTokens: this.env.ANALYSIS_MAX_TOKENS,
      });
      const res = await this.client.analyze(req, timeoutMs);
      return { res, requestHash: hashAnalyzeRequest(req) };
    };

    let outcome: { res: AnalyzeResponse; requestHash: string };
    if (this.env.TWELVELABS_VIDEO_SOURCE === 'base64' && base64Eligible) {
      outcome = await attempt({ type: 'base64_string', base64_string: (await input.loadVideo()).toString('base64') });
    } else {
      try {
        outcome = await attempt({ type: 'url', url: input.videoUrl });
      } catch (err) {
        const retryable = err instanceof ProviderError && (err.code === 'PROVIDER_UNAVAILABLE' || err.code === 'PROVIDER_REJECTED');
        if (!retryable || !base64Eligible) throw err;
        outcome = await attempt({ type: 'base64_string', base64_string: (await input.loadVideo()).toString('base64') });
      }
    }

    return {
      source: 'LIVE',
      raw: outcome.res,
      parsed: parseProviderData(outcome.res),
      requestHash: outcome.requestHash,
      promptVersion: this.env.ANALYSIS_PROMPT_VERSION,
      model: this.env.TWELVELABS_MODEL,
    };
  }
}

export function parseProviderData(res: AnalyzeResponse): ProviderResult {
  if (res.finish_reason === 'length') {
    throw new ProviderError('INVALID_RESPONSE', 'Provider output truncated (finish_reason=length)', { message: res.error?.message });
  }
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(res.data));
  } catch {
    throw new ProviderError('INVALID_RESPONSE', 'Provider `data` is not valid JSON', { data: res.data.slice(0, 500) });
  }
  const parsed = providerResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new ProviderError('INVALID_RESPONSE', 'Provider JSON does not match the response schema', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data;
}

function stripCodeFence(s: string): string {
  const t = s.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  return m?.[1] ?? t;
}

/**
 * AI_MODE=fake: never calls a provider. Returns the fixture whose sha256 matches the upload,
 * otherwise a fixed "no detection" result. Always PRERECORDED so the UI badge is honest.
 */
export class FakeAnalysisProvider implements AnalysisProvider {
  readonly kind = 'fake' as const;

  constructor(
    private readonly store: PrerecordedStore,
    private readonly env: Env,
  ) {}

  async analyze(input: AnalysisInput): Promise<ProviderOutcome> {
    const fixture = this.store.findBySha256(input.submission.sha256);
    if (fixture) {
      return {
        source: 'PRERECORDED',
        raw: fixture.rawResponse ?? { fixture: fixture.file },
        parsed: {
          incidentDetected: fixture.result.incidentDetected,
          incidentTimestampSeconds: fixture.result.incidentTimestampSeconds ?? 0,
          victimVehicle: fixture.result.victimVehicle,
          otherVehicle: fixture.result.otherVehicle,
          event: fixture.result.event,
          relevance: fixture.result.relevance,
          evidence: fixture.result.evidence,
        },
        requestHash: null,
        promptVersion: fixture.promptVersion,
        model: fixture.model,
      };
    }
    return {
      source: 'PRERECORDED',
      raw: { fake: true, note: 'AI_MODE=fake with no matching fixture' },
      parsed: {
        incidentDetected: false,
        incidentTimestampSeconds: 0,
        victimVehicle: '식별되지 않음',
        otherVehicle: null,
        event: '사고 후보 장면을 찾지 못했습니다.',
        relevance: 'LOW',
        evidence: ['요청 정보와 일치하는 장면이 관찰되지 않음'],
      },
      requestHash: null,
      promptVersion: this.env.ANALYSIS_PROMPT_VERSION,
      model: this.env.TWELVELABS_MODEL,
    };
  }
}

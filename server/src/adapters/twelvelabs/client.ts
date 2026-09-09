import { createHash } from 'node:crypto';
import { TWELVELABS_RESPONSE_SCHEMA_V1 } from './schema.js';

export type ProviderErrorCode = 'PROVIDER_UNAVAILABLE' | 'PROVIDER_REJECTED' | 'INVALID_RESPONSE' | 'TIMEOUT';

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type VideoSource = { type: 'url'; url: string } | { type: 'base64_string'; base64_string: string };

export interface MediaSource {
  name: string;
  media_type: 'image';
  url?: string;
  base64_string?: string;
}

export interface AnalyzeRequest {
  model_name: string;
  video: VideoSource;
  prompt?: string;
  prompt_v2?: { input_text: string; media_sources?: MediaSource[] };
  temperature: number;
  stream: false;
  max_tokens: number;
  response_format: { type: 'json_schema'; json_schema: Record<string, unknown> };
}

export interface AnalyzeResponse {
  id?: string;
  data: string;
  finish_reason?: 'stop' | 'length' | string;
  usage?: Record<string, unknown>;
  error?: { message: string };
}

export interface AnalyzeClient {
  analyze(req: AnalyzeRequest, timeoutMs: number): Promise<AnalyzeResponse>;
}

export interface TwelveLabsClientOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/** Thin HTTP client for `POST {baseUrl}/analyze` (sync, non-streamed). Never logs the key or URLs. */
export class TwelveLabsClient implements AnalyzeClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: TwelveLabsClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async analyze(req: AnalyzeRequest, timeoutMs: number): Promise<AnalyzeResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/+$/, '')}/analyze`, {
        method: 'POST',
        headers: { 'x-api-key': this.opts.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new ProviderError('TIMEOUT', `TwelveLabs request exceeded ${timeoutMs}ms`);
      throw new ProviderError('PROVIDER_UNAVAILABLE', `TwelveLabs request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const snippet = text.slice(0, 500);
      if (res.status === 429 || res.status >= 500) {
        throw new ProviderError('PROVIDER_UNAVAILABLE', `TwelveLabs ${res.status}`, { status: res.status, body: snippet });
      }
      throw new ProviderError('PROVIDER_REJECTED', `TwelveLabs ${res.status}`, { status: res.status, body: snippet });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProviderError('INVALID_RESPONSE', 'TwelveLabs returned non-JSON body', { body: text.slice(0, 500) });
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { data?: unknown }).data !== 'string') {
      throw new ProviderError('INVALID_RESPONSE', 'TwelveLabs response has no string `data`', { body: text.slice(0, 500) });
    }
    return parsed as AnalyzeResponse;
  }
}

export function buildAnalyzeRequest(input: {
  model: string;
  video: VideoSource;
  promptText: string;
  mediaSources: MediaSource[];
  temperature: number;
  maxTokens: number;
}): AnalyzeRequest {
  const base = {
    model_name: input.model,
    video: input.video,
    temperature: input.temperature,
    stream: false as const,
    max_tokens: input.maxTokens,
    response_format: { type: 'json_schema' as const, json_schema: TWELVELABS_RESPONSE_SCHEMA_V1 as unknown as Record<string, unknown> },
  };
  return input.mediaSources.length ? { ...base, prompt_v2: { input_text: input.promptText, media_sources: input.mediaSources } } : { ...base, prompt: input.promptText };
}

/** Stable hash of the request minus volatile signed URLs / base64 payloads, stored as `request_payload_hash`. */
export function hashAnalyzeRequest(req: AnalyzeRequest): string {
  const video = req.video.type === 'url' ? { type: 'url', url: stripQuery(req.video.url) } : { type: 'base64_string', bytes: req.video.base64_string.length };
  const media = req.prompt_v2?.media_sources?.map((m) => ({ name: m.name, url: m.url ? stripQuery(m.url) : undefined, base64: m.base64_string ? m.base64_string.length : undefined }));
  const stable = { model: req.model_name, video, prompt: req.prompt ?? req.prompt_v2?.input_text, media, temperature: req.temperature, max_tokens: req.max_tokens, schema: req.response_format.json_schema };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return i >= 0 ? url.slice(0, i) : url;
}

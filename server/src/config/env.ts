import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def: number) => z.coerce.number().int().nonnegative().default(def);

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3001),
  API_PREFIX: z.string().default('/api/v1'),
  LOG_LEVEL: z.string().default('info'),
  CORS_ORIGINS: csv,
  PUBLIC_APP_URL: z.string().default('http://localhost:3000'),
  REQUEST_TIMEOUT_MS: int(30_000),
  RATE_LIMIT_PER_MINUTE: int(60),

  DEMO_MODE: bool.default(false),
  DEMO_ADMIN_TOKEN: z.string().default(''),
  DEMO_DATE: z.string().default(''),
  DEMO_TIMEZONE: z.string().default('Asia/Seoul'),
  DEMO_REQUESTER_EMAIL: z.string().default('demo.requester@lumina.local'),
  DEMO_WITNESS_EMAIL: z.string().default('demo.witness@lumina.local'),
  DEMO_OPERATOR_EMAIL: z.string().default('demo.operator@lumina.local'),
  DEMO_ACCOUNT_PASSWORD: z.string().default(''),

  DATABASE_URL: z.string().default(''),
  SUPABASE_URL: z.string().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
  SUPABASE_BUCKET_PHOTOS: z.string().default('incident-photos'),
  SUPABASE_BUCKET_VIDEOS: z.string().default('evidence-videos'),
  UPLOAD_SIGNED_URL_TTL_SEC: int(600),
  VIDEO_SIGNED_URL_TTL_SEC: int(900),
  PHOTO_SIGNED_URL_TTL_SEC: int(900),
  STAGING_RETENTION_HOURS: int(24),
  STAGING_SWEEP_INTERVAL_MIN: int(60),

  MAX_PHOTO_BYTES: int(10 * 1024 * 1024),
  MAX_PHOTO_COUNT: int(2),
  MAX_VIDEO_BYTES: int(200 * 1024 * 1024),
  MIN_VIDEO_SECONDS: int(4),
  MAX_VIDEO_SECONDS: int(3600),
  VIDEO_PROBE_ENABLED: bool.default(false),
  FFPROBE_PATH: z.string().default('ffprobe'),

  MATCH_TIME_PADDING_MIN: int(15),
  VISIT_RETENTION_DAYS: int(30),

  AI_MODE: z.enum(['live', 'fake']).default('live'),
  AI_PROVIDER: z.string().default('twelvelabs'),
  TWELVELABS_API_KEY: z.string().default(''),
  TWELVELABS_BASE_URL: z.string().default('https://api.twelvelabs.io/v1.3'),
  TWELVELABS_MODEL: z.string().default('pegasus1.5'),
  ANALYSIS_PROMPT_VERSION: z.string().default('v1'),
  ANALYSIS_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.2),
  ANALYSIS_MAX_TOKENS: int(1024),
  TWELVELABS_VIDEO_SOURCE: z.enum(['url', 'base64']).default('url'),
  TWELVELABS_BASE64_MAX_BYTES: int(25 * 1024 * 1024),
  ANALYSIS_USE_REFERENCE_IMAGES: bool.default(true),
  ANALYSIS_TIMEOUT_MS: int(120_000),
  ANALYSIS_MAX_ATTEMPTS: int(2),
  ANALYSIS_QUEUE_CONCURRENCY: int(1),
  PRERECORDED_FALLBACK_ENABLED: bool.default(true),
  PRERECORDED_FIXTURES_DIR: z.string().default('./fixtures/prerecorded'),

  DEMO_DEPOSIT_AMOUNT: int(100_000),
  DEMO_PLATFORM_FEE: int(20_000),
  DISPUTE_WINDOW_HOURS: int(72),
});

export type Env = z.infer<typeof rawSchema>;

export class EnvError extends Error {
  constructor(public readonly missing: string[], detail?: string) {
    super(`Invalid environment: ${detail ?? `missing ${missing.join(', ')}`}`);
    this.name = 'EnvError';
  }
}

/**
 * Parses and validates process env. Always required: DATABASE_URL, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY. TWELVELABS_API_KEY is required only when AI_MODE=live.
 * A missing key never silently switches AI_MODE to fake.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env, opts: { requireInfra?: boolean } = {}): Env {
  const parsed = rawSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvError([], parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const env = parsed.data;
  const requireInfra = opts.requireInfra ?? env.NODE_ENV !== 'test';
  const missing: string[] = [];
  if (requireInfra) {
    if (!env.DATABASE_URL) missing.push('DATABASE_URL');
    if (!env.SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  }
  if (env.AI_MODE === 'live' && !env.TWELVELABS_API_KEY) missing.push('TWELVELABS_API_KEY (required when AI_MODE=live)');
  if (env.DEMO_MODE && !env.DEMO_ADMIN_TOKEN && requireInfra) missing.push('DEMO_ADMIN_TOKEN (required when DEMO_MODE=true)');
  if (missing.length) throw new EnvError(missing);
  if (env.DEMO_MODE && env.PRERECORDED_FALLBACK_ENABLED && env.PRERECORDED_FIXTURES_DIR === '') {
    throw new EnvError([], 'PRERECORDED_FIXTURES_DIR must be set when PRERECORDED_FALLBACK_ENABLED=true');
  }
  return env;
}

export function envWarnings(env: Env): string[] {
  const warnings: string[] = [];
  if (env.DEMO_MODE && env.AI_MODE === 'fake') {
    warnings.push('DEMO_MODE=true with AI_MODE=fake: analysis results will be PRERECORDED fixtures, not live TwelveLabs calls. Use AI_MODE=live for the presentation.');
  }
  return warnings;
}

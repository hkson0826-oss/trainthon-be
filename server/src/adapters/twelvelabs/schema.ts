import { z } from 'zod';

/**
 * Response schema sent to TwelveLabs as `response_format.json_schema` (BE_SPEC F6).
 * Constraints honoured: no additionalProperties/minLength/maxItems, first property required,
 * `timestamp` only at top level (never inside anyOf), no start_time/end_time names.
 * Also persisted verbatim in fixtures/twelvelabs-schema.v1.json.
 */
export const TWELVELABS_RESPONSE_SCHEMA_V1 = {
  type: 'object',
  properties: {
    incidentDetected: { type: 'boolean' },
    incidentTimestampSeconds: { type: 'timestamp', format: 'seconds' },
    victimVehicle: { type: 'string' },
    otherVehicle: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    event: { type: 'string' },
    relevance: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
    evidence: { type: 'array', items: { type: 'string' }, minItems: 1 },
  },
  required: ['incidentDetected', 'incidentTimestampSeconds', 'victimVehicle', 'event', 'relevance', 'evidence'],
} as const;

/** What the model must return (after JSON.parse of `data`). */
export const providerResultSchema = z
  .object({
    incidentDetected: z.boolean(),
    // `seconds` format returns a JSON number; be lenient with numeric strings and hh:mm:ss.
    incidentTimestampSeconds: z.union([z.number(), z.string()]),
    victimVehicle: z.string(),
    otherVehicle: z.string().nullable().optional(),
    event: z.string(),
    relevance: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    evidence: z.array(z.string()).min(1),
  })
  .passthrough();

export type ProviderResult = z.infer<typeof providerResultSchema>;

/** Server-stored `result` (FE contract). */
export interface AnalysisResult {
  incidentDetected: boolean;
  incidentTimestampSeconds: number | null;
  incidentTimestampLabel: string | null;
  victimVehicle: string;
  otherVehicle: string | null;
  event: string;
  relevance: 'HIGH' | 'MEDIUM' | 'LOW';
  evidence: string[];
  videoDurationSec: number | null;
  disclaimer: string;
}

export const analysisResultSchema: z.ZodType<AnalysisResult> = z.object({
  incidentDetected: z.boolean(),
  incidentTimestampSeconds: z.number().nullable(),
  incidentTimestampLabel: z.string().nullable(),
  victimVehicle: z.string(),
  otherVehicle: z.string().nullable(),
  event: z.string(),
  relevance: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  evidence: z.array(z.string()),
  videoDurationSec: z.number().nullable(),
  disclaimer: z.string(),
});

/** Parses a `seconds` / `hh:mm:ss[.fff]` timestamp into seconds; returns null when unparseable. */
export function parseTimestampSeconds(v: number | string): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const trimmed = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const m = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(trimmed) ?? /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!m) return null;
  if (m.length === 3) return Number(m[1]) * 60 + Number(m[2]);
  const ms = m[4] ? Number(m[4].padEnd(3, '0')) / 1000 : 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms;
}

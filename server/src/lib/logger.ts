import pino from 'pino';

export type Logger = pino.Logger;

const REDACT_PATHS = [
  'req.headers.authorization',
  'headers.authorization',
  '*.apiKey',
  '*.serviceRoleKey',
  '*.signedUrl',
  '*.token',
  'TWELVELABS_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];

export function createLogger(level = 'info'): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: null,
  });
}

export const silentLogger: Logger = pino({ level: 'silent' });

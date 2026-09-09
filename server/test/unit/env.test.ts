import { describe, expect, it } from 'vitest';
import { EnvError, envWarnings, loadEnv } from '../../src/config/env.js';

const infra = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
};

describe('loadEnv', () => {
  it('requires TWELVELABS_API_KEY only when AI_MODE=live', () => {
    expect(() => loadEnv({ ...infra, AI_MODE: 'live' })).toThrow(EnvError);
    expect(() => loadEnv({ ...infra, AI_MODE: 'live', TWELVELABS_API_KEY: 'k' })).not.toThrow();
    expect(() => loadEnv({ ...infra, AI_MODE: 'fake' })).not.toThrow();
  });

  it('never silently switches AI_MODE to fake', () => {
    try {
      loadEnv({ ...infra });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      expect((err as EnvError).missing.join(' ')).toContain('TWELVELABS_API_KEY');
    }
  });

  it('requires infra vars outside test mode and DEMO_ADMIN_TOKEN when DEMO_MODE=true', () => {
    expect(() => loadEnv({ AI_MODE: 'fake' })).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ ...infra, AI_MODE: 'fake', DEMO_MODE: 'true' })).toThrow(/DEMO_ADMIN_TOKEN/);
    expect(() => loadEnv({ ...infra, AI_MODE: 'fake', DEMO_MODE: 'true', DEMO_ADMIN_TOKEN: 't' })).not.toThrow();
  });

  it('parses CSV origins, booleans and numbers', () => {
    const env = loadEnv({ ...infra, AI_MODE: 'fake', CORS_ORIGINS: 'http://a, http://b', PORT: '4000', DEMO_MODE: '1', DEMO_ADMIN_TOKEN: 't' });
    expect(env.CORS_ORIGINS).toEqual(['http://a', 'http://b']);
    expect(env.PORT).toBe(4000);
    expect(env.DEMO_MODE).toBe(true);
  });

  it('warns when DEMO_MODE and AI_MODE=fake are combined', () => {
    const env = loadEnv({ ...infra, AI_MODE: 'fake', DEMO_MODE: 'true', DEMO_ADMIN_TOKEN: 't' });
    expect(envWarnings(env)).toHaveLength(1);
    expect(envWarnings(loadEnv({ ...infra, AI_MODE: 'live', TWELVELABS_API_KEY: 'k' }))).toHaveLength(0);
  });
});

describe('loadDotenv', () => {
  it('loads a .env file without overriding existing variables and ignores comments/quotes', async () => {
    const { loadDotenv } = await import('../../src/config/dotenv.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'lumina-env-'));
    const file = path.join(dir, '.env');
    writeFileSync(file, '# comment\nDOTENV_TEST_A=hello # trailing\nDOTENV_TEST_B="quoted value"\nexport DOTENV_TEST_C=c\nDOTENV_TEST_EXISTING=from-file\n');
    process.env.DOTENV_TEST_EXISTING = 'from-process';
    expect(loadDotenv(file)).toBe(file);
    expect(process.env.DOTENV_TEST_A).toBe('hello');
    expect(process.env.DOTENV_TEST_B).toBe('quoted value');
    expect(process.env.DOTENV_TEST_C).toBe('c');
    expect(process.env.DOTENV_TEST_EXISTING).toBe('from-process');
    expect(loadDotenv(path.join(dir, 'missing.env'))).toBeNull();
  });
});

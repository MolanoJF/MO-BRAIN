// test/unit/env.test.ts
import { describe, expect, test } from 'bun:test';
import { loadEnv } from '../../src/server/env.ts';

const base = {
  DATABASE_URL: 'postgres://mobrain:x@postgres:5432/mobrain',
  ENCRYPTION_KEY: 'k'.repeat(44),
  GBRAIN_VERSION: '0.60.230.0',
  GBRAIN_ADMIN_BOOTSTRAP_TOKEN: 'admin-token',
};

describe('loadEnv', () => {
  test('applies defaults', () => {
    const e = loadEnv(base);
    expect(e.port).toBe(3000);
    expect(e.gbrainUrl).toBe('http://gbrain:3131');
    expect(e.publicUrl).toBe('http://127.0.0.1:8787');
    expect(e.uiDir).toBe('dist/ui');
    expect(e.secureCookies).toBe(false);
    expect(e.packsDir).toBe('/app/packs'); expect(e.gbrainHome).toBe('/srv/gbrain-home');
    expect(e.gbrainSkillsDir).toBe('/opt/gbrain/skills'); expect(e.appDir).toBe('/app');
  });

  test('https public url turns on secure cookies and strips a trailing slash', () => {
    const e = loadEnv({ ...base, MOBRAIN_PUBLIC_URL: 'https://brain.example.ts.net:8443/' });
    expect(e.publicUrl).toBe('https://brain.example.ts.net:8443');
    expect(e.secureCookies).toBe(true);
  });

  test('refuses a missing or short encryption key', () => {
    expect(() => loadEnv({ ...base, ENCRYPTION_KEY: 'short' })).toThrow(/ENCRYPTION_KEY/);
    const { ENCRYPTION_KEY: _, ...rest } = base;
    expect(() => loadEnv(rest)).toThrow(/ENCRYPTION_KEY/);
  });

  test('refuses a missing database url or pin', () => {
    const { DATABASE_URL: _, ...noDb } = base;
    expect(() => loadEnv(noDb)).toThrow(/DATABASE_URL/);
    const { GBRAIN_VERSION: __, ...noPin } = base;
    expect(() => loadEnv(noPin)).toThrow(/GBRAIN_VERSION/);
  });

  test('loads the gbrain admin bootstrap token but refuses a missing one', () => {
    expect(loadEnv(base).gbrainAdminToken).toBe('admin-token');
    const { GBRAIN_ADMIN_BOOTSTRAP_TOKEN: _, ...noToken } = base;
    expect(() => loadEnv(noToken)).toThrow(/GBRAIN_ADMIN_BOOTSTRAP_TOKEN/);
  });
});

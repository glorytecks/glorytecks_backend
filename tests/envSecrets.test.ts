/**
 * Production secret validation (A7 security review).
 *
 * `SUPABASE_JWT_SECRET` is optional — without it tokens are verified by the
 * Auth server — but when it is set, `requireAuth` trusts any HS256 token
 * signed with it. A guessable value there would let anyone sign an
 * administrator's token, so production now refuses a weak one exactly as it
 * refuses a weak COOKIE_SECRET. SITE_API_KEY gets the same treatment.
 */
import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { secretProblem } from '../src/config/env';

test('a published example value is not a secret', () => {
  for (const value of [
    'changeme',
    'ChangeMe@12345',
    'dev_cookie_secret',
    'placeholder',
    // Supabase's published development JWT secret: long, but public.
    'super-secret-jwt-token-with-at-least-32-characters-long',
  ]) {
    assert.match(secretProblem('SUPABASE_JWT_SECRET', value) ?? '', /known default\/example value/, value);
  }
});

test('a short value is not a secret', () => {
  assert.match(secretProblem('SUPABASE_JWT_SECRET', 'x'.repeat(31)) ?? '', /at least 32 characters/);
});

test('a long random value is accepted', () => {
  assert.equal(secretProblem('SUPABASE_JWT_SECRET', 'k3Jq9vX2mP7wL5tR8yB4nC6zH1fD0sGaE2uY'), null);
});

/** Boot `config/env` in a production child process with the given overrides. */
function bootInProduction(overrides: Record<string, string>) {
  const root = path.resolve(__dirname, '..');
  return spawnSync(process.execPath, ['--import', 'tsx', '-e', "require('./src/config/env')"], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      NODE_ENV: 'production',
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_ANON_KEY: 'test-anon-key-not-real',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-key-not-real',
      COOKIE_SECRET: 'c'.repeat(48),
      CORS_ORIGINS: 'https://admin.example.invalid',
      ...overrides,
    },
  });
}

test('production refuses to boot with a weak SUPABASE_JWT_SECRET', () => {
  const run = bootInProduction({ SUPABASE_JWT_SECRET: 'changeme' });
  assert.notEqual(run.status, 0, 'boot must fail');
  assert.match(run.stderr, /SUPABASE_JWT_SECRET is set to a known default\/example value/);
});

test('production refuses to boot with a short SITE_API_KEY', () => {
  const run = bootInProduction({ SITE_API_KEY: 'short-key' });
  assert.notEqual(run.status, 0, 'boot must fail');
  assert.match(run.stderr, /SITE_API_KEY must be at least 32 characters/);
});

test('production boots with both unset, or with credible values', () => {
  assert.equal(bootInProduction({}).status, 0, bootInProduction({}).stderr);
  const strong = bootInProduction({ SUPABASE_JWT_SECRET: 'j'.repeat(40), SITE_API_KEY: 's'.repeat(40) });
  assert.equal(strong.status, 0, strong.stderr);
});

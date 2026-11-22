/**
 * The admin panel's other ways in: email code, Google (via /auth/session) and
 * forgot/reset password — exercised through the real app with Supabase stubbed.
 *
 * The property every test leans on: whichever method is used, only an
 * identity with an ACTIVE admin_users profile gets a session, and nothing
 * here creates an account or tells a caller which addresses are admins.
 */
import './authMethodsEnv';
import './setup';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import app from '../src/app';
import { supabaseAdmin, supabaseAuth } from '../src/config/supabase';
import { adminUserRepo } from '../src/repositories';

let server: http.Server;
let base: string;
let ipCounter = 10;

test.before(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
test.after(() => server.close());
test.afterEach(() => mock.restoreAll());

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: { success?: boolean; message?: string; data?: Record<string, unknown> };
}

function call(path: string, opts: { method?: string; body?: unknown } = {}): Promise<Reply> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const ip = `203.0.113.${ipCounter++}`;
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: opts.method ?? 'GET',
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          'X-Forwarded-For': ip,
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let body = {};
          try {
            body = JSON.parse(raw);
          } catch {
            /* empty */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@glorytecks.test', role: 'admin', isActive: true };

/** A JWT-shaped token whose payload carries the given claims (signature unused: the stubbed getUser decides validity). */
const token = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

function stubProfiles(byEmail: Record<string, typeof ADMIN | null>, byId: Record<string, typeof ADMIN | null> = {}) {
  mock.method(adminUserRepo, 'findOne', async (filter: { email?: string }) => byEmail[filter.email ?? ''] ?? null);
  mock.method(adminUserRepo, 'findById', async (id: string) => byId[id] ?? null);
  mock.method(adminUserRepo, 'updateRawById', async () => null);
}

/* ── Email code ─────────────────────────────────────────────────────────── */

test('a code is requested for an active admin only, never creates an account, and the reply is the same', async () => {
  stubProfiles({ 'admin@glorytecks.test': ADMIN });
  const sent = mock.method(supabaseAuth.auth, 'signInWithOtp', async () => ({ data: {}, error: null }));

  const admin = await call('/auth/otp/request', { method: 'POST', body: { email: 'admin@glorytecks.test' } });
  const stranger = await call('/auth/otp/request', { method: 'POST', body: { email: 'someone@else.test' } });

  assert.equal(admin.status, 200);
  assert.equal(stranger.status, 200);
  assert.equal(admin.body.message, stranger.body.message, 'no difference a caller could read');
  assert.equal(sent.mock.callCount(), 1);
  const args = sent.mock.calls[0].arguments[0] as { email: string; options: Record<string, unknown> };
  assert.equal(args.email, 'admin@glorytecks.test');
  assert.equal(args.options.shouldCreateUser, false);
  assert.equal(args.options.emailRedirectTo, 'https://admin.glorytecks.test/auth/callback');
});

test('a correct code opens a session; a wrong one is refused', async () => {
  stubProfiles({}, { 'admin-1': ADMIN });
  mock.method(supabaseAuth.auth, 'verifyOtp', async (p: { token: string }) =>
    p.token === '123456'
      ? { data: { session: { access_token: 'acc', refresh_token: 'ref' }, user: { id: 'admin-1' } }, error: null }
      : { data: { session: null, user: null }, error: { message: 'Token has expired or is invalid', status: 403 } },
  );

  const bad = await call('/auth/otp/verify', { method: 'POST', body: { email: 'admin@glorytecks.test', code: '000000' } });
  assert.equal(bad.status, 401);

  const ok = await call('/auth/otp/verify', { method: 'POST', body: { email: 'admin@glorytecks.test', code: '123456' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data?.accessToken, 'acc');
  assert.match(String(ok.headers['set-cookie']), /HttpOnly/i);
});

test('a valid code for an identity with no admin profile does not open the panel', async () => {
  stubProfiles({}, {});
  mock.method(supabaseAuth.auth, 'verifyOtp', async () => ({
    data: { session: { access_token: 'acc', refresh_token: 'ref' }, user: { id: 'nobody' } },
    error: null,
  }));
  const signOut = mock.method(supabaseAdmin.auth.admin, 'signOut', async () => ({ data: null, error: null }));
  const res = await call('/auth/otp/verify', { method: 'POST', body: { email: 'x@y.test', code: '123456' } });
  assert.equal(res.status, 401);
  assert.equal(signOut.mock.callCount(), 1, 'the stray session is revoked');
});

test('a correct password for an identity with no admin profile revokes that session, and no other', async () => {
  stubProfiles({}, {});
  mock.method(supabaseAuth.auth, 'signInWithPassword', async () => ({
    data: { session: { access_token: 'stranger-access', refresh_token: 'stranger-refresh' }, user: { id: 'nobody' } },
    error: null,
  }));
  const revoke = mock.method(supabaseAdmin.auth.admin, 'signOut', async () => ({ data: null, error: null }));
  // The shared client's own signOut() acts on whichever session it stored
  // last, which under load is not necessarily this one (audit 2026-11-14, F-07).
  const sharedSignOut = mock.method(supabaseAuth.auth, 'signOut', async () => ({ error: null }));

  const res = await call('/auth/login', { method: 'POST', body: { email: 'x@y.test', password: 'a correct password' } });

  assert.equal(res.status, 401);
  assert.equal(res.body.message, 'Invalid email or password', 'the same reply as a wrong password');
  assert.equal(res.headers['set-cookie'], undefined, 'no refresh cookie');
  assert.equal(revoke.mock.callCount(), 1, 'the stray session is revoked');
  assert.deepEqual(revoke.mock.calls[0].arguments, ['stranger-access', 'global'], 'by its own token');
  assert.equal(sharedSignOut.mock.callCount(), 0, 'never through the shared client');
});

test('a malformed code is rejected before Supabase is asked', async () => {
  const verify = mock.method(supabaseAuth.auth, 'verifyOtp', async () => ({ data: {}, error: null }));
  const res = await call('/auth/otp/verify', { method: 'POST', body: { email: 'admin@glorytecks.test', code: '12ab' } });
  assert.equal(res.status, 422);
  assert.equal(verify.mock.callCount(), 0);
});

/* ── Google / email link → /auth/session ─────────────────────────────────── */

test('a Google sign-in by an admin becomes a panel session with rotated tokens', async () => {
  stubProfiles({}, { 'admin-1': ADMIN });
  mock.method(supabaseAdmin.auth, 'getUser', async () => ({ data: { user: { id: 'admin-1', created_at: '2020-01-01T00:00:00Z' } }, error: null }));
  mock.method(supabaseAuth.auth, 'refreshSession', async () => ({
    data: { session: { access_token: 'fresh-acc', refresh_token: 'fresh-ref' }, user: { id: 'admin-1' } },
    error: null,
  }));
  const res = await call('/auth/session', { method: 'POST', body: { accessToken: 'x'.repeat(40), refreshToken: 'url-ref' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data?.accessToken, 'fresh-acc', 'the token that travelled in the URL is not the one kept');
});

test('a Google sign-in by a non-admin is refused and the brand-new identity removed', async () => {
  stubProfiles({}, {});
  mock.method(supabaseAdmin.auth, 'getUser', async () => ({ data: { user: { id: 'stranger', created_at: new Date().toISOString() } }, error: null }));
  mock.method(supabaseAdmin.auth.admin, 'signOut', async () => ({ data: null, error: null }));
  const removed = mock.method(supabaseAdmin.auth.admin, 'deleteUser', async () => ({ data: { user: null }, error: null }));
  const refresh = mock.method(supabaseAuth.auth, 'refreshSession', async () => ({ data: {}, error: null }));

  const res = await call('/auth/session', { method: 'POST', body: { accessToken: 'x'.repeat(40), refreshToken: 'r' } });
  assert.equal(res.status, 401);
  assert.equal(removed.mock.callCount(), 1);
  assert.equal(refresh.mock.callCount(), 0, 'no session is ever minted for it');
});

test('an older identity with no admin profile is refused but not deleted', async () => {
  stubProfiles({}, {});
  mock.method(supabaseAdmin.auth, 'getUser', async () => ({ data: { user: { id: 'old', created_at: '2020-01-01T00:00:00Z' } }, error: null }));
  mock.method(supabaseAdmin.auth.admin, 'signOut', async () => ({ data: null, error: null }));
  const removed = mock.method(supabaseAdmin.auth.admin, 'deleteUser', async () => ({ data: { user: null }, error: null }));
  const res = await call('/auth/session', { method: 'POST', body: { accessToken: 'x'.repeat(40), refreshToken: 'r' } });
  assert.equal(res.status, 401);
  assert.equal(removed.mock.callCount(), 0);
});

test('Google sign-in answers 503 with a clear message while the provider is off', async () => {
  // setup.ts makes every request to the local Supabase URL fail, so the
  // settings check sees no enabled provider.
  const res = await call('/auth/google');
  assert.equal(res.status, 503);
  assert.match(String(res.body.message), /Google sign-in is not set up/);
});

test('Google sign-in returns the provider address when it is enabled', async () => {
  const realFetch = globalThis.fetch;
  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith('/auth/v1/settings')
      ? new Response(JSON.stringify({ external: { google: true } }), { status: 200 })
      : realFetch(input, init),
  );
  mock.method(supabaseAuth.auth, 'signInWithOAuth', async () => ({ data: { url: 'https://accounts.example/authorize' }, error: null }));
  const res = await call('/auth/google');
  assert.equal(res.status, 200);
  assert.equal(res.body.data?.url, 'https://accounts.example/authorize');
});

/* ── Forgot / reset password ─────────────────────────────────────────────── */

test('a reset email goes to an active admin only, with the same reply for anyone', async () => {
  stubProfiles({ 'admin@glorytecks.test': ADMIN });
  const sent = mock.method(supabaseAuth.auth, 'resetPasswordForEmail', async () => ({ data: {}, error: null }));
  const a = await call('/auth/password/forgot', { method: 'POST', body: { email: 'admin@glorytecks.test' } });
  const b = await call('/auth/password/forgot', { method: 'POST', body: { email: 'nobody@else.test' } });
  assert.equal(a.status, 200);
  assert.equal(a.body.message, b.body.message);
  assert.equal(sent.mock.callCount(), 1);
  assert.deepEqual(sent.mock.calls[0].arguments[1], { redirectTo: 'https://admin.glorytecks.test/reset-password' });
});

test('the reset link sets a new password only with a recovery token', async () => {
  stubProfiles({}, { 'admin-1': ADMIN });
  mock.method(supabaseAdmin.auth, 'getUser', async () => ({ data: { user: { id: 'admin-1' } }, error: null }));
  mock.method(supabaseAdmin.auth.admin, 'signOut', async () => ({ data: null, error: null }));
  const update = mock.method(supabaseAdmin.auth.admin, 'updateUserById', async () => ({ data: { user: {} }, error: null }));
  const now = Math.floor(Date.now() / 1000);

  const ordinary = token({ iat: now, amr: [{ method: 'password' }], pad: 'x'.repeat(20) });
  const refused = await call('/auth/password/reset', { method: 'POST', body: { accessToken: ordinary, newPassword: 'NewPassw0rd!' } });
  assert.equal(refused.status, 401, 'a normal session token cannot skip the current-password check');
  assert.equal(update.mock.callCount(), 0);

  const recovery = token({ iat: now, amr: [{ method: 'recovery' }], pad: 'x'.repeat(20) });
  const ok = await call('/auth/password/reset', { method: 'POST', body: { accessToken: recovery, newPassword: 'NewPassw0rd!' } });
  assert.equal(ok.status, 200);
  assert.equal(update.mock.callCount(), 1);
});

test('the reset code path verifies the code, then signs every session out', async () => {
  stubProfiles({}, { 'admin-1': ADMIN });
  mock.method(supabaseAuth.auth, 'verifyOtp', async (p: { type: string; token: string }) =>
    p.type === 'recovery' && p.token === '654321'
      ? { data: { session: { access_token: 'rec', refresh_token: 'r' }, user: { id: 'admin-1' } }, error: null }
      : { data: { session: null, user: null }, error: { message: 'invalid', status: 403 } },
  );
  const update = mock.method(supabaseAdmin.auth.admin, 'updateUserById', async () => ({ data: { user: {} }, error: null }));
  const signOut = mock.method(supabaseAdmin.auth.admin, 'signOut', async () => ({ data: null, error: null }));

  const wrong = await call('/auth/password/reset', { method: 'POST', body: { email: 'admin@glorytecks.test', code: '111111', newPassword: 'NewPassw0rd!' } });
  assert.equal(wrong.status, 401);

  const ok = await call('/auth/password/reset', { method: 'POST', body: { email: 'admin@glorytecks.test', code: '654321', newPassword: 'NewPassw0rd!' } });
  assert.equal(ok.status, 200);
  assert.equal(update.mock.callCount(), 1);
  assert.equal(signOut.mock.callCount(), 1);
});

test('a short new password is rejected at the edge', async () => {
  const res = await call('/auth/password/reset', { method: 'POST', body: { email: 'admin@glorytecks.test', code: '654321', newPassword: 'short' } });
  assert.equal(res.status, 422);
});

import './setup';
import { SUBJECT, resetDb } from './dashboardTestEnv';
import './authLocalEnv';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import app from '../src/app';
import { env } from '../src/config/env';
import { supabaseAdmin } from '../src/config/supabase';

/**
 * SUPABASE_VERIFY_JWT_LOCALLY: checking a token against the project's published
 * keys, instead of asking the Auth server on every request. Off unless asked
 * for. A faster answer must not be a weaker one about who is asking: the role
 * still comes from admin_users, and any doubt about the token is a 401.
 */

type Claims = { aud?: unknown; sub?: unknown; role?: unknown };

let claims: { data: { claims: Claims } | null; error: unknown } = { data: null, error: null };
let identity: { data: { user: { id: string } | null }; error: unknown } = { data: { user: null }, error: null };
const calls = { getClaims: 0, getUser: 0 };

const auth = supabaseAdmin.auth as unknown as { getClaims: unknown; getUser: unknown };
auth.getClaims = async () => {
  calls.getClaims += 1;
  return claims;
};
auth.getUser = async () => {
  calls.getUser += 1;
  return identity;
};

let server: http.Server;
let base: string;

test.before(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.after(() => server.close());

test.beforeEach(() => {
  resetDb({ contact_enquiries: [] });
  calls.getClaims = 0;
  calls.getUser = 0;
});

const pulse = () => fetch(`${base}/api/v1/dashboard/pulse`, { headers: { Authorization: 'Bearer a-token' } });

test('a valid token is accepted without a call to the Auth server', async () => {
  claims = { data: { claims: { aud: 'authenticated', sub: SUBJECT.admin } }, error: null };
  assert.equal((await pulse()).status, 200);
  assert.deepEqual(calls, { getClaims: 1, getUser: 0 });
});

test('a token for another audience is refused', async () => {
  claims = { data: { claims: { aud: 'anon', sub: SUBJECT.admin } }, error: null };
  assert.equal((await pulse()).status, 401);
});

test('a token with no usable subject is refused', async () => {
  claims = { data: { claims: { aud: 'authenticated', sub: 42 } }, error: null };
  assert.equal((await pulse()).status, 401);
  claims = { data: { claims: { aud: 'authenticated' } }, error: null };
  assert.equal((await pulse()).status, 401);
});

test('a failed check is refused, whatever came with it', async () => {
  claims = { data: { claims: { aud: 'authenticated', sub: SUBJECT.admin } }, error: new Error('bad signature') };
  assert.equal((await pulse()).status, 401);
  claims = { data: null, error: null };
  assert.equal((await pulse()).status, 401);
});

test('a role claimed in the token counts for nothing', async () => {
  claims = { data: { claims: { aud: 'authenticated', sub: SUBJECT.viewer, role: 'admin' } }, error: null };
  assert.equal((await pulse()).status, 403);
});

test('a valid token with no admin account is refused', async () => {
  claims = { data: { claims: { aud: 'authenticated', sub: '99999999-9999-4999-8999-999999999999' } }, error: null };
  assert.equal((await pulse()).status, 401);
});

test('with the setting off, the Auth server decides, as it always has', async () => {
  const supabase = env.supabase as { verifyJwtLocally: boolean };
  supabase.verifyJwtLocally = false;
  try {
    identity = { data: { user: { id: SUBJECT.admin } }, error: null };
    assert.equal((await pulse()).status, 200);
    assert.deepEqual(calls, { getClaims: 0, getUser: 1 });
  } finally {
    supabase.verifyJwtLocally = true;
  }
});

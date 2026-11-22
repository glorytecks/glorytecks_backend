import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { analyticsConfig, normalisePrivateKey, parsePropertyId, parseSiteUrl, publicConfig, searchConsoleConfig } from '../src/integrations/google/config';
import { accessToken, clearTokenCache, signAssertion, TOKEN_URL } from '../src/integrations/google/auth';
import { classify, GoogleApiError, googleRequest, type GoogleDeps } from '../src/integrations/google/http';
import { parse, ResponseShapeError, v } from '../src/integrations/google/schema';
import { addDays, change, dateInZone, gscDaily, gscTotals, movers, periods, worthReviewing, type GscItem } from '../src/integrations/google/reports';

/**
 * The Google integration's building blocks, offline. The service account key
 * below is generated for this run and thrown away — it is not a credential
 * for anything. Google itself is never called: every answer is a FIXTURE.
 */

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const EMAIL = 'gt-analytics-reader@fixture-project.iam.gserviceaccount.com';

function withEnv(vars: Record<string, string>, fn: () => void) {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, vars);
    fn();
  } finally {
    process.env = saved;
  }
}

/* ── Configuration ────────────────────────────────────────────────────────── */

test('credentials absent: not configured, naming the missing variables', () => {
  const sc = searchConsoleConfig();
  assert.equal(sc.state, 'not-configured');
  assert.deepEqual((sc as { missing: string[] }).missing, ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'GSC_SITE_URL']);
  const ga = analyticsConfig();
  assert.deepEqual((ga as { missing: string[] }).missing, ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'GA4_PROPERTY_ID']);
});

test('invalid configuration: each problem names its variable and never echoes a value', () => {
  withEnv(
    {
      GOOGLE_SERVICE_ACCOUNT_EMAIL: 'someone@gmail.com',
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: 'not-a-key-SENTINEL-VALUE',
      GSC_SITE_URL: 'https://glorytecks.com',
      GA4_PROPERTY_ID: 'G-MKXRJHXL9C',
    },
    () => {
      const sc = searchConsoleConfig();
      assert.equal(sc.state, 'invalid');
      const problems = (sc as { problems: string[] }).problems.join(' | ');
      assert.match(problems, /GOOGLE_SERVICE_ACCOUNT_EMAIL is not a service account address/);
      assert.match(problems, /GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is not a PEM private key/);
      assert.match(problems, /GSC_SITE_URL must end with "\/"/);
      assert.match((analyticsConfig() as { problems: string[] }).problems.join(' '), /GA4_PROPERTY_ID must be the numeric GA4 property id/);
      assert.doesNotMatch(problems, /SENTINEL|gmail/);
      const view = publicConfig('search-console');
      assert.equal(view.serviceAccountEmail, null, 'a malformed address is not shown');
      assert.doesNotMatch(JSON.stringify(view), /SENTINEL/);
    },
  );
});

test('a valid configuration is accepted; the key may use real line breaks or \\n', () => {
  for (const key of [PEM, PEM.replace(/\n/g, '\\n'), `"${PEM.replace(/\n/g, '\\n')}"`]) {
    withEnv({ GOOGLE_SERVICE_ACCOUNT_EMAIL: EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: key, GSC_SITE_URL: 'sc-domain:GloryTecks.com', GA4_PROPERTY_ID: 'properties/123456789' }, () => {
      const sc = searchConsoleConfig();
      assert.equal(sc.state, 'configured');
      assert.equal((sc as { value: { siteUrl: string } }).value.siteUrl, 'sc-domain:glorytecks.com');
      const ga = analyticsConfig();
      assert.equal((ga as { value: { propertyId: string } }).value.propertyId, '123456789');
      const view = publicConfig('analytics');
      assert.deepEqual({ email: view.serviceAccountEmail, id: view.identifier }, { email: EMAIL, id: '123456789' });
      assert.doesNotMatch(JSON.stringify(view), /PRIVATE KEY/);
    });
  }
  assert.equal(normalisePrivateKey('"a\\nb"'), 'a\nb');
  assert.deepEqual(parseSiteUrl('https://glorytecks.com/'), { ok: true, siteUrl: 'https://glorytecks.com/' });
  assert.equal(parseSiteUrl('ftp://glorytecks.com/').ok, false);
  assert.equal(parseSiteUrl('sc-domain:not a host').ok, false);
  assert.equal(parsePropertyId('123').ok, false);
});

/* ── Signing in as the service account ────────────────────────────────────── */

const account = { email: EMAIL, privateKey: crypto.createPrivateKey(PEM) };

test('the JWT assertion is RS256-signed with the read-only scope and a one-hour lifetime', () => {
  const now = Date.parse('2026-10-25T10:00:00Z');
  const jwt = signAssertion(account, 'https://www.googleapis.com/auth/webmasters.readonly', now);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.deepEqual(claims, {
    iss: EMAIL,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: TOKEN_URL,
    iat: now / 1000 - 30, // a little clock skew allowed
    exp: now / 1000 - 30 + 3600, // Google: at most one hour after iat
  });
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')), 'verifies with the public key');
});

/** A FIXTURE Google: answers by URL, records what was asked. */
function fakeGoogle(answer: (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> } | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const slept: number[] = [];
  let clock = Date.parse('2026-10-25T10:00:00Z');
  const deps: GoogleDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const a = answer(url, init);
      if (a instanceof Error) throw a;
      return new Response(a.body === undefined ? '' : typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status, headers: a.headers });
    }) as unknown as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  };
  return { deps, calls, slept, advance: (ms: number) => (clock += ms) };
}

test('access tokens are fetched once and reused until close to expiry; the token never leaves memory', async () => {
  clearTokenCache();
  const g = fakeGoogle((url) => (url === TOKEN_URL ? { status: 200, body: { access_token: 'ya29.FIXTURE-TOKEN', expires_in: 3599, token_type: 'Bearer' } } : { status: 404 }));
  assert.equal(await accessToken(account, 'scope-a', g.deps), 'ya29.FIXTURE-TOKEN');
  assert.equal(await accessToken(account, 'scope-a', g.deps), 'ya29.FIXTURE-TOKEN');
  assert.equal(g.calls.length, 1, 'cached');
  const form = new URLSearchParams(String(g.calls[0].init.body));
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(form.get('assertion')?.split('.').length, 3);
  g.advance(3599_000 - 30_000);
  await accessToken(account, 'scope-a', g.deps);
  assert.equal(g.calls.length, 2, 'renewed a minute before expiry');
});

test('failed auth: invalid_grant becomes a plain auth-failed message without the assertion or key', async () => {
  clearTokenCache();
  const g = fakeGoogle(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } }));
  await assert.rejects(accessToken(account, 'scope-b', g.deps), (err: GoogleApiError) => {
    assert.equal(err.kind, 'auth-failed');
    assert.match(err.safeMessage, /invalid_grant: Invalid JWT Signature/);
    assert.doesNotMatch(err.safeMessage, /eyJ|PRIVATE KEY/);
    return true;
  });
  assert.equal(g.calls.length, 1, 'a refused key is not retried');
});

test('failed auth: Google token errors get a plain next step, by their error string', async () => {
  // FIXTURE wording, as Google's token endpoint words these.
  const cases: [unknown, RegExp][] = [
    [{ error: 'invalid_grant', error_description: 'Invalid grant: account not found' }, /Check GOOGLE_SERVICE_ACCOUNT_EMAIL/],
    [{ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, /does not belong to this service account/],
    [{ error: 'invalid_grant', error_description: 'Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe.' }, /clock is out of step/],
    [{ error: 'disabled_client', error_description: 'The OAuth client was disabled.' }, /This key is disabled/],
  ];
  for (const [body, hint] of cases) {
    clearTokenCache();
    const g = fakeGoogle(() => ({ status: 400, body }));
    await assert.rejects(accessToken(account, 'scope-c', g.deps), (err: GoogleApiError) => {
      assert.equal(err.kind, 'auth-failed');
      assert.match(err.safeMessage, hint);
      return true;
    });
  }
});

test('simultaneous requests for a token share one exchange', async () => {
  clearTokenCache();
  const g = fakeGoogle(() => ({ status: 200, body: { access_token: 'ya29.FIXTURE-TOKEN', expires_in: 3599, token_type: 'Bearer' } }));
  const tokens = await Promise.all([1, 2, 3].map(() => accessToken(account, 'scope-d', g.deps)));
  assert.deepEqual(tokens, ['ya29.FIXTURE-TOKEN', 'ya29.FIXTURE-TOKEN', 'ya29.FIXTURE-TOKEN']);
  assert.equal(g.calls.length, 1);
});

/* ── Requests: retries, quota, timeouts, shapes ───────────────────────────── */

test('quota: a 429 is not retried (Google asks for minutes to hours); a short Retry-After on a 503 is honoured', async () => {
  const q = fakeGoogle(() => ({ status: 429, headers: { 'retry-after': '2' }, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } } }));
  await assert.rejects(googleRequest('https://example.test/a', { method: 'GET' }, q.deps), (err: GoogleApiError) => err.kind === 'quota');
  assert.equal(q.calls.length, 1, 'one request, no retry');

  let n = 0;
  const g = fakeGoogle(() => (++n === 1 ? { status: 503, headers: { 'retry-after': '2' }, body: { error: { code: 503, status: 'UNAVAILABLE', message: 'Backend error' } } } : { status: 200, body: { ok: true } }));
  assert.deepEqual(await googleRequest('https://example.test/a', { method: 'GET' }, g.deps), { ok: true });
  assert.deepEqual(g.slept, [2000]);
});

test('quota: a long Retry-After is not waited out inside a request; the error says when to try again', async () => {
  const g = fakeGoogle(() => ({ status: 429, headers: { 'retry-after': '3600' }, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Exhausted property tokens per day' } } }));
  await assert.rejects(googleRequest('https://example.test/a', { method: 'GET' }, g.deps), (err: GoogleApiError) => {
    assert.equal(err.kind, 'quota');
    assert.equal(err.retryAfterSeconds, 3600);
    assert.match(err.safeMessage, /quota was reached: Exhausted property tokens per day/);
    return true;
  });
  assert.equal(g.calls.length, 1);
});

test('server errors and timeouts are retried a bounded number of times, then reported', async () => {
  const g = fakeGoogle(() => ({ status: 503, body: { error: { code: 503, status: 'UNAVAILABLE', message: 'Backend error' } } }));
  await assert.rejects(googleRequest('https://example.test/a', { method: 'GET' }, g.deps), (err: GoogleApiError) => err.kind === 'unavailable');
  assert.equal(g.calls.length, 2, 'one retry at most (GA4 limits server errors per hour)');

  const t = fakeGoogle(() => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
  await assert.rejects(googleRequest('https://example.test/a', { method: 'GET' }, t.deps), (err: GoogleApiError) => {
    assert.equal(err.kind, 'timeout');
    assert.match(err.safeMessage, /did not answer within 8 s/);
    return true;
  });
});

test('permission, not found and bad requests are classified, and are not retried', async () => {
  assert.equal(classify(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: "User does not have sufficient permission for site 'sc-domain:glorytecks.com'." } }).kind, 'permission-denied');
  assert.equal(classify(403, { error: { code: 403, message: 'Quota', errors: [{ reason: 'rateLimitExceeded' }] } }).kind, 'quota', 'a rate-limit 403 is a quota error');
  assert.equal(classify(403, { error: { code: 403, message: 'Daily limit', errors: [{ reason: 'dailyLimitExceeded' }] } }).kind, 'quota');
  // FIXTURE wording, in the shapes Search Console (errors[]) and GA4 (AIP-193 details[]) use.
  assert.equal(classify(403, { error: { code: 403, message: 'Access Not Configured.', errors: [{ reason: 'accessNotConfigured' }] } }).kind, 'api-disabled');
  const disabled = classify(403, {
    error: {
      code: 403,
      status: 'PERMISSION_DENIED',
      message: 'Google Analytics Data API has not been used in project 000000000000 before or it is disabled.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com' }],
    },
  });
  assert.equal(disabled.kind, 'api-disabled');
  assert.match(disabled.safeMessage, /not enabled in the service account's Google Cloud project/);
  assert.equal(classify(404, { error: { status: 'NOT_FOUND', message: 'Property not found' } }).kind, 'not-found');
  assert.equal(classify(400, { error: { status: 'INVALID_ARGUMENT', message: 'Field foo is not a valid metric' } }).kind, 'invalid-request');
  const g = fakeGoogle(() => ({ status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'No access' } } }));
  await assert.rejects(googleRequest('https://example.test/a', { method: 'GET' }, g.deps));
  assert.equal(g.calls.length, 1);
  assert.equal(classify(401, { error: { message: 'Bearer ya29.SECRET-TOKEN-VALUE invalid' } }).safeMessage.includes('ya29.SECRET-TOKEN-VALUE'), false, 'bearer tokens are redacted');
});

test('a response that is not the expected shape is refused, not half-read', () => {
  const shape = v.object({ rows: v.array(v.object({ clicks: v.number(), keys: v.optional(v.array(v.string())) })) });
  assert.deepEqual(parse(shape, {}), { rows: [] }, 'an absent list is empty');
  assert.throws(() => parse(shape, { rows: [{ clicks: '12' }] }), (e: ResponseShapeError) => e.path === '$.rows[0].clicks');
  assert.throws(() => parse(v.object({ value: v.numericString() }), { value: 'twelve' }), ResponseShapeError);
  assert.equal(parse(v.numericString(), '0.5321'), 0.5321);
});

/* ── Report arithmetic (FIXTURE numbers) ──────────────────────────────────── */

test('date comparisons: the previous period is the same length, ending the day before', () => {
  assert.deepEqual(periods('2026-10-22', 7), {
    current: { startDate: '2026-10-16', endDate: '2026-10-22' },
    previous: { startDate: '2026-10-09', endDate: '2026-10-15' },
  });
  // 28 days ending 1 March 2026 start on 2 February (February 2026 has 28 days).
  assert.deepEqual(periods('2026-03-01', 28), {
    current: { startDate: '2026-02-02', endDate: '2026-03-01' },
    previous: { startDate: '2026-01-05', endDate: '2026-02-01' },
  });
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dateInZone(Date.parse('2026-10-25T05:00:00Z'), 'America/Los_Angeles'), '2026-10-24', 'Search Console days are Pacific Time');
  assert.deepEqual(change(120, 100), { current: 120, previous: 100, delta: 20, pct: 20 });
  assert.deepEqual(change(5, 0), { current: 5, previous: 0, delta: 5, pct: null }, 'no percentage from zero');
  assert.deepEqual(change(5, null), { current: 5, previous: null, delta: null, pct: null }, 'nothing to compare is not zero');
});

test('Search Console totals: clicks and impressions add up; CTR and position are recomputed, position weighted by impressions', () => {
  const t = gscTotals([
    { clicks: 10, impressions: 100, position: 2 },
    { clicks: 0, impressions: 300, position: 10 },
  ]);
  assert.deepEqual(t, { clicks: 10, impressions: 400, ctr: 0.025, position: 8 });
  assert.deepEqual(gscTotals([]), { clicks: 0, impressions: 0, ctr: 0, position: null }, 'empty data: no position, not position 0');
  const days = gscDaily([{ keys: ['2026-10-21'], clicks: 3, impressions: 40, ctr: 0.075, position: 4 }], { startDate: '2026-10-20', endDate: '2026-10-22' });
  assert.deepEqual(days.map((d) => [d.date, d.clicks, d.position]), [['2026-10-20', 0, null], ['2026-10-21', 3, 4], ['2026-10-22', 0, null]]);
});

const item = (key: string, clicks: number, impressions: number, position: number): GscItem => ({ key, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

test('gains and drops only compare queries present in both periods', () => {
  const now = [item('python course', 50, 1000, 3), item('data science', 5, 500, 9), item('brand new', 40, 400, 2)];
  const before = [item('python course', 20, 900, 5), item('data science', 30, 600, 6), item('gone', 25, 300, 4)];
  const m = movers(now, before);
  assert.deepEqual(m.gains.map((g) => [g.key, g.clicks.delta]), [['python course', 30]]);
  assert.deepEqual(m.drops.map((g) => [g.key, g.clicks.delta]), [['data science', -25]]);
});

test('“worth reviewing” lists say why each item is there', () => {
  const now = [item('dropped page', 4, 500, 5), item('low ctr', 1, 400, 4), item('near page one', 3, 120, 11), item('fine', 80, 900, 2)];
  const before = [item('dropped page', 20, 520, 4)];
  const list = worthReviewing(now, before);
  assert.deepEqual(list.map((r) => [r.key, r.reason, r.previousClicks]), [
    ['dropped page', 'clicks-dropped', 20],
    ['low ctr', 'low-ctr-on-first-page', null],
    ['near page one', 'near-first-page', null],
  ]);
});

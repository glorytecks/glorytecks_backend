import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { checkAuditUrl, createTransport, FetchFailure, isBlockedAddress, AUDIT_USER_AGENT, type Resolver } from '../src/lib/safeHttp';
import { auditConfig, parseAuditOrigin } from '../src/seo/audit/config';
import { AUDIT_ROBOTS_TOKEN, parseRobots, robotsAllows } from '../src/seo/audit/robots';

/**
 * What keeps the technical SEO audit on the site it was configured for:
 * the URL allowlist, the address checks behind it (SSRF), the request limits,
 * the origin configuration and the robots.txt policy for the audit's crawler.
 *
 * The HTTP cases talk to a FIXTURE server on 127.0.0.1 — never the network.
 * Reaching it needs the two test-only transport options; every case that
 * leaves them off shows the same server cannot be reached.
 */

/* ── URL allowlist ────────────────────────────────────────────────────────── */

const SITE = ['glorytecks.com', 'www.glorytecks.com'];

test('checkAuditUrl: only https, on the default port, to an approved host by name', () => {
  assert.equal(checkAuditUrl('https://glorytecks.com/courses', SITE).ok, true);
  assert.equal(checkAuditUrl('https://WWW.GloryTecks.com./courses', SITE).ok, true, 'case and a trailing dot do not matter');

  const refused: [string, RegExp][] = [
    ['http://glorytecks.com/', /only https/],
    ['ftp://glorytecks.com/', /only https/],
    ['javascript:alert(1)', /only https/],
    ['file:///etc/passwd', /only https/],
    ['https://glorytecks.com:8443/', /port 8443/],
    ['https://user:pass@glorytecks.com/', /credentials/],
    ['https://evil.example/', /not an approved host/],
    ['https://glorytecks.com.evil.example/', /not an approved host/],
    ['https://127.0.0.1/', /IP address/],
    ['https://169.254.169.254/latest/meta-data/', /IP address/],
    ['https://[::1]/', /IP address/],
    ['https://2130706433/', /IP address/],
    ['https://0x7f.1/', /IP address/],
    ['https://localhost/', /local or internal/],
    ['https://api.localhost/', /local or internal/],
    ['https://printer.local/', /local or internal/],
    ['https://metadata.google.internal/', /local or internal/],
    ['not a url', /not a valid absolute URL/],
    ['/relative/path', /not a valid absolute URL/],
  ];
  for (const [url, reason] of refused) {
    const result = checkAuditUrl(url, [...SITE, 'localhost', 'api.localhost', 'printer.local', 'metadata.google.internal']);
    assert.equal(result.ok, false, url);
    assert.match((result as { reason: string }).reason, reason, url);
  }
});

test('isBlockedAddress: private, loopback, link-local (cloud metadata), CGNAT, multicast, reserved and documentation ranges', () => {
  const blocked = [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1',
    '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '::127.0.0.1',
    'not-an-ip', '',
  ];
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ['76.76.21.21', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

/* ── Requests (FIXTURE server on 127.0.0.1) ───────────────────────────────── */

interface Hit {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
}

let server: http.Server;
let port = 0;
const hits: Hit[] = [];

test.before(async () => {
  server = http.createServer((req, res) => {
    hits.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers });
    if (req.url === '/hang') return; // never answers
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/next' });
      return res.end('moved');
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('x'.repeat(10_000));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' });
    res.end('<title>FIXTURE</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
test.after(() => server.close());
test.beforeEach(() => {
  hits.length = 0;
});

/** Resolves the FIXTURE host name to whatever the case needs. */
const resolveTo = (...addresses: string[]): Resolver => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const fixtureUrl = (path: string) => `http://fixture.test:${port}${path}`;
const local = (extra: Parameters<typeof createTransport>[0] = {}) =>
  createTransport({ resolver: resolveTo('127.0.0.1'), allowHttp: true, allowPrivateAddresses: true, ...extra });

async function failure(promise: Promise<unknown>): Promise<FetchFailure> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof FetchFailure, String(err));
    return err;
  }
  assert.fail('expected the request to fail');
}

test('transport: a host resolving to a private address is refused before any connection is made', async () => {
  const transport = createTransport({ resolver: resolveTo('127.0.0.1'), allowHttp: true });
  const err = await failure(transport.fetch(fixtureUrl('/'), { readBody: true }));
  assert.match(err.reason, /private or reserved address/);
  assert.equal(err.transient, false);
  assert.equal(hits.length, 0, 'the fixture server never saw a request');
});

test('transport: one private address among public ones is enough to refuse (DNS rebinding)', async () => {
  const transport = createTransport({ resolver: resolveTo('76.76.21.21', '169.254.169.254'), allowHttp: true });
  const err = await failure(transport.fetch(fixtureUrl('/')));
  assert.match(err.reason, /private or reserved address/);
  assert.equal(hits.length, 0);
});

test('transport: IP-literal hosts in a private range are refused without a lookup', async () => {
  const transport = createTransport({ allowHttp: true });
  for (const url of [`http://127.0.0.1:${port}/`, 'https://169.254.169.254/latest/meta-data/', `http://[::1]:${port}/`]) {
    const err = await failure(transport.fetch(url));
    assert.match(err.reason, /private or reserved address/, url);
  }
  assert.equal(hits.length, 0);
});

test('transport: https only unless a test opts in; a name that does not resolve is a plain failure', async () => {
  const strict = createTransport({ resolver: resolveTo('127.0.0.1'), allowPrivateAddresses: true });
  assert.match((await failure(strict.fetch(fixtureUrl('/')))).reason, /only https/);
  const nowhere = createTransport({
    resolver: async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    },
    allowHttp: true,
  });
  const err = await failure(nowhere.fetch('http://nowhere.test/'));
  assert.match(err.reason, /does not resolve/);
  assert.equal(err.transient, false);
});

test('transport: every request has a deadline, and a timeout may be retried', async () => {
  const started = Date.now();
  const err = await failure(local().fetch(fixtureUrl('/hang'), { timeoutMs: 150 }));
  assert.match(err.reason, /no answer within 0\.2 s/);
  assert.equal(err.transient, true);
  assert.ok(Date.now() - started < 2000);
});

test('transport: redirects are reported, never followed', async () => {
  const res = await local().fetch(fixtureUrl('/redirect'), { readBody: true });
  assert.equal(res.status, 302);
  assert.equal(res.location, '/next');
  assert.deepEqual(hits.map((h) => h.path), ['/redirect']);
});

test('transport: bodies are capped, read only when asked for, and the crawler names itself', async () => {
  const big = await local().fetch(fixtureUrl('/big'), { readBody: true, maxBytes: 1000 });
  assert.equal(big.truncated, true);
  assert.equal(big.body?.length, 1000);

  const headersOnly = await local().fetch(fixtureUrl('/'), { readBody: false });
  assert.equal(headersOnly.body, null);
  assert.equal(headersOnly.xRobotsTag, 'noindex');

  const head = await local().fetch(fixtureUrl('/'), { method: 'HEAD', readBody: true });
  assert.equal(head.body, null);

  for (const hit of hits) {
    assert.equal(hit.headers['user-agent'], AUDIT_USER_AGENT);
    assert.equal(hit.headers['accept-encoding'], 'identity');
    assert.equal(hit.headers.cookie, undefined);
    assert.equal(hit.headers.authorization, undefined);
  }
  assert.deepEqual(hits.map((h) => h.method), ['GET', 'GET', 'HEAD']);
});

/* ── Configuration ────────────────────────────────────────────────────────── */

test('SEO_AUDIT_ORIGIN must be the site: production, a subdomain of it, or a *.vercel.app deployment', () => {
  const ok = (raw: string, origin: string) => assert.deepEqual(parseAuditOrigin(raw), { ok: true, origin, host: new URL(origin).hostname }, raw);
  ok('https://glorytecks.com', 'https://glorytecks.com');
  ok('https://glorytecks.com/', 'https://glorytecks.com');
  ok(' https://www.glorytecks.com ', 'https://www.glorytecks.com');
  ok('https://staging.glorytecks.com', 'https://staging.glorytecks.com');
  ok('https://glorytecks-site-git-main-team.vercel.app', 'https://glorytecks-site-git-main-team.vercel.app');

  const bad: [string | undefined, RegExp][] = [
    [undefined, /not set/],
    ['', /not set/],
    ['http://glorytecks.com', /https/],
    ['https://glorytecks.com/blog', /origin only/],
    ['https://glorytecks.com/?x=1', /origin only/],
    ['https://glorytecks.com:8443', /port/],
    ['https://user:pw@glorytecks.com', /credentials/],
    ['https://76.76.21.21', /IP address/],
    ['https://evil.example', /must be https:\/\/glorytecks\.com/],
    ['https://glorytecks.com.evil.example', /must be https:\/\/glorytecks\.com/],
    ['https://notglorytecks.com', /must be https:\/\/glorytecks\.com/],
    ['https://localhost', /must be https:\/\/glorytecks\.com/],
    ['nonsense', /not a valid URL/],
  ];
  for (const [raw, reason] of bad) {
    const result = parseAuditOrigin(raw);
    assert.equal(result.ok, false, String(raw));
    assert.match((result as { reason: string }).reason, reason, String(raw));
  }
});

test('auditConfig: hosts, the staging rule and clamped budgets', () => {
  const saved = { ...process.env };
  try {
    process.env.SEO_AUDIT_ORIGIN = 'https://glorytecks.com';
    process.env.SEO_AUDIT_MAX_PAGES = '50000';
    process.env.SEO_AUDIT_STEP_MS = '100';
    let state = auditConfig();
    assert.equal(state.ok, true);
    let config = (state as Extract<typeof state, { ok: true }>).config;
    assert.deepEqual(config.pageHosts, ['glorytecks.com', 'www.glorytecks.com']);
    assert.ok(config.mediaHosts.includes('res.cloudinary.com'));
    assert.equal(config.production, true);
    assert.equal(config.hostNoindex, false);
    assert.equal(config.maxPages, 1000, 'capped');
    assert.equal(config.stepMs, 4000, 'raised to the floor');
    assert.ok(config.timeoutMs <= config.stepMs / 2);
    assert.ok(config.concurrency <= 3);

    process.env.SEO_AUDIT_ORIGIN = 'https://preview-abc.vercel.app';
    process.env.SEO_AUDIT_MAX_PAGES = 'lots';
    process.env.SEO_AUDIT_STEP_MS = '';
    state = auditConfig();
    config = (state as Extract<typeof state, { ok: true }>).config;
    assert.deepEqual(config.pageHosts, ['preview-abc.vercel.app'], 'no www twin for a deployment host');
    assert.ok(config.linkHosts.includes('glorytecks.com'), 'links to the production host count as internal');
    assert.equal(config.production, false);
    assert.equal(config.hostNoindex, true);
    assert.equal(config.maxPages, 300, 'unparseable falls back to the default');
    assert.equal(config.stepMs, 8000);

    process.env.SEO_AUDIT_ORIGIN = '';
    const off = auditConfig();
    assert.equal(off.ok, false);
    assert.match((off as { setup: string }).setup, /SEO_AUDIT_ORIGIN/);
  } finally {
    process.env = saved;
  }
});

/* ── robots.txt for the audit's own crawler (RFC 9309) ────────────────────── */

test('robots: the group naming the audit crawler wins over *, and the longest rule decides', () => {
  const policy = parseRobots(
    [
      '# FIXTURE robots.txt',
      'User-agent: *',
      'Disallow: /',
      '',
      `User-agent: ${AUDIT_ROBOTS_TOKEN.toLowerCase()}`,
      'User-agent: SomeOtherBot',
      'Disallow: /private',
      'Allow: /private/open',
      'Disallow: /*.pdf$',
      'Disallow: /search?*q=',
      'Sitemap: https://glorytecks.com/sitemap.xml',
    ].join('\n'),
  );
  assert.deepEqual(policy.sitemaps, ['https://glorytecks.com/sitemap.xml']);
  assert.equal(robotsAllows(policy, '/courses'), true, 'the * group does not apply when ours exists');
  assert.equal(robotsAllows(policy, '/private/page'), false);
  assert.equal(robotsAllows(policy, '/private/open/page'), true, 'longer Allow wins');
  assert.equal(robotsAllows(policy, '/brochure.pdf'), false);
  assert.equal(robotsAllows(policy, '/brochure.pdf?x=1'), true, '$ anchors the end');
  assert.equal(robotsAllows(policy, '/search?page=1&q=python'), false, '* matches any run');
  assert.equal(robotsAllows(policy, '/robots.txt'), true, 'robots.txt itself is always allowed');
});

test('robots: without our group, * applies; an empty Disallow allows everything; ties go to Allow', () => {
  const site = parseRobots('User-agent: *\nAllow: /\nDisallow: /api/\n');
  assert.equal(robotsAllows(site, '/'), true);
  assert.equal(robotsAllows(site, '/api/revalidate'), false);

  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow:\n'), '/anything'), true);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /a\nAllow: /a\n'), '/a'), true);
  assert.equal(robotsAllows(parseRobots(''), '/anything'), true, 'no rules: allowed');
  assert.equal(robotsAllows(parseRobots('User-agent: OtherBot\nDisallow: /\n'), '/x'), true, 'a group for another crawler does not apply');
});

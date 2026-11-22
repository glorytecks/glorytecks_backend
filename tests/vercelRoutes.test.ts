import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import app from '../src/app';
import { env } from '../src/config/env';

/**
 * Which requests Vercel hands to the application (vercel.json → routes).
 *
 * Until 2026-11-12 the one route was `/(.*)`: every path on the API host ran
 * the whole Express app, so each scanner probe for /.env or /wp-login.php was
 * a function run — and, on a quiet API, a cold start that loads ~930 modules —
 * only to be told 404 by the app. Function time on the host is metered.
 *
 * Now only the paths the app actually serves reach it: the API prefix and the
 * root greeting. Anything else gets the platform's own 404 without starting a
 * function. These tests keep that list equal to what the app serves, so a route
 * added outside the prefix cannot be cut off unnoticed.
 */

interface Route {
  src: string;
  dest: string;
}

const config = JSON.parse(readFileSync(path.resolve(__dirname, '../vercel.json'), 'utf8')) as {
  builds: { src: string; use: string }[];
  routes: Route[];
};

/** Vercel anchors a route's `src` at both ends and matches the path without its query string. */
const routed = (pathname: string): string | null => {
  for (const route of config.routes) {
    const anchored = `${route.src.startsWith('^') ? '' : '^'}${route.src}${route.src.endsWith('$') ? '' : '$'}`;
    if (new RegExp(anchored, 'i').test(pathname)) return route.dest;
  }
  return null;
};

const APP = 'src/server.ts';

test('every route points at the one function the build produces', () => {
  assert.deepEqual(config.builds.map((b) => b.src), [APP]);
  for (const route of config.routes) assert.equal(route.dest, APP, route.src);
});

test('the API prefix and everything under it reach the app', () => {
  // The routes are written for the default prefix. If API_PREFIX ever moves out
  // from under /api/, vercel.json must change with it — this is the reminder.
  assert.ok(env.apiPrefix.startsWith('/api/'), `API prefix ${env.apiPrefix} is not under /api/`);

  const paths = [
    '/health',
    '/public/settings',
    '/public/blogs',
    '/public/blogs/some-post',
    '/public/blogs/some-post/context',
    '/public/courses/data-science',
    '/public/brochures/data-science/download',
    '/public/demo-requests',
    '/public/contact',
    '/public/chat-enquiries',
    '/auth/login',
    '/auth/refresh',
    '/auth/google/callback',
    '/dashboard/pulse',
    '/dashboard/stats',
    '/blogs',
    '/courses/123e4567-e89b-12d3-a456-426614174000',
    '/uploads/config',
    '/uploads/image',
    '/settings',
    '/page-seo',
    '/seo-audit/runs',
    '/analytics/overview',
    '/enquiries',
  ];
  for (const p of paths) assert.equal(routed(`${env.apiPrefix}${p}`), APP, p);
});

test('the root greeting still reaches the app', () => {
  assert.equal(routed('/'), APP);
});

test('probe and junk paths never start the app', () => {
  const junk = [
    '/.env',
    '/.env.production',
    '/.git/config',
    '/wp-login.php',
    '/wp-admin/',
    '/wp-admin/setup-config.php',
    '/xmlrpc.php',
    '/phpinfo.php',
    '/admin',
    '/login',
    '/favicon.ico',
    '/robots.txt',
    '/sitemap.xml',
    '/index.php',
    '/config.json',
    '/actuator/health',
    '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php',
    // Close to the prefix, but not under it.
    '/api',
    '/apiv1/health',
    '/api.php',
    '/apidocs',
    '/v1/health',
    '/health',
  ];
  for (const p of junk) assert.equal(routed(p), null, p);
});

test('the routes cover every path the app itself mounts', () => {
  // Express keeps its top-level layers on the router stack: `route` for a path
  // registered with app.get, and a prefix regexp for app.use(prefix, …). Any
  // layer bound to a path must be the root greeting or sit under the API prefix.
  type Layer = { route?: { path: string }; regexp?: RegExp; name?: string };
  const stack = ((app as unknown as { _router: { stack: Layer[] } })._router?.stack ?? []) as Layer[];
  assert.ok(stack.length > 0, 'could not read the app router');

  const exactPaths = stack.filter((l) => l.route).map((l) => l.route!.path);
  assert.deepEqual(exactPaths, ['/'], 'a path registered outside the API prefix needs a vercel.json route');

  // Mounted prefixes: every one that is not "match everything" must accept the
  // API prefix — i.e. nothing is mounted at some other top-level path.
  const mounts = stack.filter((l) => !l.route && l.regexp && !l.regexp.test('/zz-not-a-mount'));
  assert.ok(mounts.length > 0, 'the API router is mounted under a prefix');
  for (const layer of mounts) {
    assert.ok(layer.regexp!.test(`${env.apiPrefix}/health`), `a layer is mounted outside ${env.apiPrefix}: ${layer.regexp}`);
  }
});

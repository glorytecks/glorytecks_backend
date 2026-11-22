import { env } from '../config/env';
import { cacheGet, cacheSet } from './cache';

/**
 * Is the public website answering?
 *
 * One HEAD request to the root of the site that receives the API's refresh
 * requests: the host comes from SITE_REVALIDATE_URL (server configuration,
 * never from a request), so this cannot be pointed anywhere else. Redirects
 * are not followed — a redirect is an answer — and the body is never read.
 *
 * The result is shared for five minutes (Redis when it is available, this
 * process otherwise), so opening the dashboard does not probe the site each
 * time. It carries no role-specific data, so one shared entry is safe.
 */

export type SiteProbe =
  | { state: 'not-configured'; reason: string }
  | { state: 'up'; host: string; httpStatus: number; responseMs: number; checkedAt: string }
  | {
      state: 'down';
      host: string;
      httpStatus: number | null;
      responseMs: number | null;
      reason: string;
      checkedAt: string;
    };

export const SITE_PROBE_TTL_SECONDS = 300;
const CACHE_KEY = 'admin:dashboard:site-probe';
const DEFAULT_TIMEOUT_MS = 5000;

let memo: { value: SiteProbe; until: number } | null = null;

/** The site's root URL, or why it cannot be checked. Never includes a secret. */
export function siteRoot(url: string = env.siteRevalidation.url): URL | string {
  if (!url) return 'SITE_REVALIDATE_URL is not set';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'SITE_REVALIDATE_URL is not a valid URL';
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    return 'SITE_REVALIDATE_URL must use https (http is allowed for localhost only)';
  }
  return new URL('/', parsed.origin);
}

export interface ProbeOptions {
  url?: string;
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** Probe the site now. Never throws. */
export async function probeSite(opts: ProbeOptions = {}): Promise<SiteProbe> {
  const root = siteRoot(opts.url);
  if (typeof root === 'string') return { state: 'not-configured', reason: root };

  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checkedAt = (opts.now?.() ?? new Date()).toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await doFetch(root.href, {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'GloryTecks-Admin-StatusCheck/1.0' },
    });
    const responseMs = Math.round(performance.now() - started);
    await res.body?.cancel().catch(() => {});
    if (res.status < 400) {
      return { state: 'up', host: root.host, httpStatus: res.status, responseMs, checkedAt };
    }
    return { state: 'down', host: root.host, httpStatus: res.status, responseMs, reason: `HTTP ${res.status}`, checkedAt };
  } catch {
    return {
      state: 'down',
      host: root.host,
      httpStatus: null,
      responseMs: null,
      reason: controller.signal.aborted ? `no answer within ${timeoutMs / 1000} s` : 'could not connect',
      checkedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The latest probe, reused for five minutes. */
export async function cachedSiteProbe(opts: ProbeOptions = {}): Promise<SiteProbe> {
  const root = siteRoot(opts.url);
  // Configuration problems cost nothing to report and must show at once.
  if (typeof root === 'string') return { state: 'not-configured', reason: root };

  const sameHost = (p: SiteProbe | null | undefined): p is SiteProbe =>
    !!p && p.state !== 'not-configured' && p.host === root.host;

  const shared = await cacheGet<SiteProbe>(CACHE_KEY);
  if (sameHost(shared)) return shared;
  if (memo && memo.until > Date.now() && sameHost(memo.value)) return memo.value;

  const value = await probeSite(opts);
  memo = { value, until: Date.now() + SITE_PROBE_TTL_SECONDS * 1000 };
  void cacheSet(CACHE_KEY, value, SITE_PROBE_TTL_SECONDS);
  return value;
}

/** Tests only. */
export function resetSiteProbeMemo(): void {
  memo = null;
}

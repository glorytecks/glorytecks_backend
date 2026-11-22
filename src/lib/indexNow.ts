import { env } from '../config/env';
import { logger } from '../config/logger';
import { SITE_ORIGIN, canonicalUrlFor } from '../seo/site/canonical';

/**
 * IndexNow delivery: tell Bing and the other IndexNow engines which of the
 * site's URLs were added, changed or removed, so they are recrawled in minutes
 * instead of whenever the sitemap is next read.
 * Protocol: https://www.indexnow.org/documentation
 *
 * This file only validates and sends. WHICH urls a CMS change affects is
 * lib/indexNowChanges.ts, called from lib/cacheInvalidation.ts after a write.
 *
 * Rules:
 *   • Server-side only. The key is a public value (it is served at
 *     /<key>.txt so the engines can verify ownership), but it is switched on
 *     by INDEXNOW_KEY so a local or staging backend never submits anything.
 *   • Only absolute https URLs on the canonical host are sent; anything else
 *     (another domain, `www.`, http, a query string, a fragment) is dropped.
 *   • At most MAX_URLS_PER_REQUEST per request; larger lists are split.
 *   • One attempt per request and a short timeout, no retry: this runs inside
 *     the admin's save request on a serverless host, and a notification that
 *     is lost is made up by the sitemap. A 429 pauses all submissions from
 *     this process for the time the engine asks.
 *   • It never throws and the result is only logged: the CMS write has
 *     already succeeded.
 */

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/** The protocol's ceiling on `urlList` for a single request. */
export const MAX_URLS_PER_REQUEST = 10_000;

/** 8–128 characters of a-z, A-Z, 0-9 and dashes: the protocol's key format. */
const KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

const DEFAULT_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 15 * 60_000;

/** Why IndexNow cannot be used, or null when it is configured. Never includes the key. */
export function indexNowConfigProblem(key: string): string | null {
  if (!key) return 'INDEXNOW_KEY is not set';
  if (!KEY_PATTERN.test(key)) {
    return 'INDEXNOW_KEY must be 8-128 characters: letters, digits and dashes only';
  }
  return null;
}

/** Where the engine fetches the key file from. */
export const keyLocationFor = (key: string, origin: string = SITE_ORIGIN): string => `${origin}/${key}.txt`;

export interface NormalizedUrls {
  /** Unique canonical URLs, in first-seen order. */
  urls: string[];
  /** Inputs that were not submittable, as given. */
  rejected: string[];
}

/**
 * Keep only URLs that belong to the verified site, in canonical form.
 * Pure — unit-tested in tests/indexNow.test.ts.
 */
export function normalizeIndexNowUrls(input: readonly string[], origin: string = SITE_ORIGIN): NormalizedUrls {
  const seen = new Set<string>();
  const urls: string[] = [];
  const rejected: string[] = [];

  for (const raw of input) {
    let parsed: URL;
    try {
      parsed = new URL(String(raw).trim());
    } catch {
      rejected.push(raw);
      continue;
    }
    // `origin` pins scheme, host (so `www.` and other domains fail) and port.
    const foreign =
      parsed.origin !== origin ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '';
    if (foreign) {
      rejected.push(raw);
      continue;
    }
    const canonical = canonicalUrlFor(origin, parsed.pathname);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    urls.push(canonical);
  }
  return { urls, rejected };
}

export interface IndexNowPayload {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
}

/** The JSON body for one request. */
export function buildIndexNowPayload(
  key: string,
  urlList: string[],
  origin: string = SITE_ORIGIN,
): IndexNowPayload {
  return { host: new URL(origin).host, key, keyLocation: keyLocationFor(key, origin), urlList };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface SubmitOptions {
  key?: string;
  origin?: string;
  endpoint?: string;
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Injected in tests; defaults to MAX_URLS_PER_REQUEST. */
  batchSize?: number;
}

export type IndexNowResult =
  | { status: 'skipped'; reason: string }
  | { status: 'sent'; submitted: number; batches: number; httpStatus: number[] }
  | { status: 'failed'; reason: string; submitted: number; batches: number; httpStatus: number[] };

let pausedUntil = 0;
let warnedUnconfigured = false;

/** Clears per-process state. Tests only. */
export function resetIndexNowState(): void {
  pausedUntil = 0;
  warnedUnconfigured = false;
}

/** Logs once that IndexNow is off, so a deployment without the key is not noisy. */
export function warnIndexNowUnconfigured(problem: string): void {
  if (warnedUnconfigured) return;
  warnedUnconfigured = true;
  logger.warn(`IndexNow disabled: ${problem}. Search engines find changes through the sitemap only.`);
}

/** Retry-After in seconds → ms, bounded; anything else (a date, junk) → the default. */
function pauseFromRetryAfter(header: string | null): number {
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_PAUSE_MS;
  return Math.min(seconds * 1000, MAX_PAUSE_MS);
}

/** POST the URLs to IndexNow. Never throws. */
export async function submitToIndexNow(
  input: readonly string[],
  opts: SubmitOptions = {},
): Promise<IndexNowResult> {
  try {
    return await submit(input, opts);
  } catch (err) {
    logger.warn('IndexNow submission failed unexpectedly', { message: (err as Error).message });
    return { status: 'failed', reason: 'unexpected error', submitted: 0, batches: 0, httpStatus: [] };
  }
}

async function submit(input: readonly string[], opts: SubmitOptions): Promise<IndexNowResult> {
  const key = opts.key ?? env.indexNow.key;
  const problem = indexNowConfigProblem(key);
  if (problem) {
    warnIndexNowUnconfigured(problem);
    return { status: 'skipped', reason: problem };
  }

  const origin = opts.origin ?? SITE_ORIGIN;
  const { urls, rejected } = normalizeIndexNowUrls(input, origin);
  if (rejected.length > 0) {
    logger.warn('IndexNow: ignored URLs that do not belong to the site', { count: rejected.length });
  }
  if (urls.length === 0) return { status: 'skipped', reason: 'no valid URLs' };

  const now = opts.now ?? Date.now;
  if (now() < pausedUntil) return { status: 'skipped', reason: 'paused after a rate-limit response' };

  const doFetch = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? INDEXNOW_ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? env.indexNow.timeoutMs;
  const batches = chunk(urls, Math.min(opts.batchSize ?? MAX_URLS_PER_REQUEST, MAX_URLS_PER_REQUEST));

  const httpStatus: number[] = [];
  let submitted = 0;

  for (const batch of batches) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reason = '';
    try {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(buildIndexNowPayload(key, batch, origin)),
        signal: controller.signal,
      });
      await res.body?.cancel().catch(() => {});
      httpStatus.push(res.status);

      // 200 = received; 202 = received, the engine has yet to validate the key.
      if (res.status === 200 || res.status === 202) {
        submitted += batch.length;
        continue;
      }
      if (res.status === 429) {
        const pause = pauseFromRetryAfter(res.headers.get('retry-after'));
        pausedUntil = now() + pause;
        reason = `rate limited (HTTP 429); paused for ${Math.round(pause / 1000)} s`;
      } else if (res.status === 403 || res.status === 422) {
        // 403: key not valid. 422: URLs not on the key's host, or key mismatch.
        reason = `rejected (HTTP ${res.status}); check INDEXNOW_KEY matches the key file served at ${keyLocationFor('<key>', origin)}`;
      } else {
        reason = `HTTP ${res.status}`;
      }
    } catch {
      reason = controller.signal.aborted ? `timed out after ${timeoutMs} ms` : 'network error';
    } finally {
      clearTimeout(timer);
    }

    // The same problem would hit every remaining batch, so stop here.
    logger.warn('IndexNow submission failed; the sitemap will cover these URLs', {
      reason,
      urls: batch.length,
      httpStatus,
    });
    return { status: 'failed', reason, submitted, batches: batches.length, httpStatus };
  }

  logger.info('IndexNow submitted', { urls: submitted, batches: batches.length, httpStatus });
  return { status: 'sent', submitted, batches: batches.length, httpStatus };
}

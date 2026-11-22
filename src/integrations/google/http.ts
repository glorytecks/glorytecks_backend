import { redactText } from '../../utils/redact';
import { ResponseShapeError } from './schema';

/**
 * Calls to Google's APIs: one deadline per attempt, a bounded retry with
 * backoff for server errors and dropped connections (honouring a short
 * Retry-After), and every failure turned into a GoogleApiError whose message
 * is safe to log and to show an administrator — Google's own wording, capped,
 * with anything that looks like a credential removed. Tokens never appear in it.
 *
 * Quota answers are not retried. Search Console says "wait 15 minutes"; Google's
 * AIP-194 says retries after RESOURCE_EXHAUSTED "may not be expected to work for
 * several hours". The service holds off and serves its cached report instead.
 */

export type GoogleErrorKind =
  | 'not-configured'
  | 'invalid-config'
  | 'auth-failed'
  | 'permission-denied'
  | 'api-disabled'
  | 'not-found'
  | 'quota'
  | 'invalid-request'
  | 'unavailable'
  | 'timeout'
  | 'bad-response';

export class GoogleApiError extends Error {
  constructor(
    readonly kind: GoogleErrorKind,
    /** A sentence safe to show: no token, key or credential. */
    readonly safeMessage: string,
    readonly httpStatus: number | null = null,
    /** Seconds Google asked us to wait, when it said. */
    readonly retryAfterSeconds: number | null = null,
    /** Google's own code: an API status (PERMISSION_DENIED) or a token error (invalid_grant). */
    readonly code: string | null = null,
  ) {
    super(safeMessage);
  }
}

export interface GoogleDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const defaultDeps = (): GoogleDeps => ({
  fetch: (...args) => globalThis.fetch(...args),
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

let overrides: Partial<GoogleDeps> | null = null;

/** Tests and the local preview only: answer Google's APIs from fixtures. Refused in production. */
export function setGoogleDepsForTests(deps: Partial<GoogleDeps> | null): void {
  if (process.env.NODE_ENV === 'production') throw new Error('Google API dependencies cannot be replaced in production');
  overrides = deps;
}

export function googleDeps(): GoogleDeps {
  return { ...defaultDeps(), ...(overrides ?? {}) };
}

/** Per-attempt deadline. */
export const ATTEMPT_TIMEOUT_MS = 8000;
/** No retry starts after this long: a report request must fit inside one serverless invocation. */
const OVERALL_BUDGET_MS = 9000;
// One retry: GA4 counts every 500/503 against an hourly server-error quota, and after
// ten in an hour blocks the project from the property altogether.
const MAX_ATTEMPTS = 2;
const MAX_RETRY_AFTER_MS = 4000;

const RETRYABLE = new Set([500, 502, 503, 504]);

const short = (s: string, n = 300) => {
  const clean = redactText(s).replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
};

/**
 * Google's JSON error body → its message and status/reason codes, when present.
 * Reasons come from the older `errors[]` list (Search Console) and from the
 * AIP-193 `details[]` ErrorInfo entries (GA4).
 */
function readError(body: unknown): { message: string; status: string; reasons: string[] } {
  const err = (body as { error?: unknown })?.error;
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; status?: unknown; errors?: unknown; details?: unknown };
    const reasonsOf = (list: unknown) =>
      Array.isArray(list) ? list.map((x) => String((x as { reason?: unknown })?.reason ?? '')).filter(Boolean) : [];
    return {
      message: typeof e.message === 'string' ? e.message : '',
      status: typeof e.status === 'string' ? e.status : '',
      reasons: [...reasonsOf(e.errors), ...reasonsOf(e.details)],
    };
  }
  // OAuth token endpoint shape: { error: 'invalid_grant', error_description: '…' }
  const b = body as { error?: unknown; error_description?: unknown } | null;
  if (b && typeof b.error === 'string') {
    return { message: typeof b.error_description === 'string' ? `${b.error}: ${b.error_description}` : b.error, status: b.error, reasons: [] };
  }
  return { message: '', status: '', reasons: [] };
}

// Search Console sends quota failures as 403 with these reasons, as well as 429.
const QUOTA_REASONS = /^(rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded|RATE_LIMIT_EXCEEDED)$/;
// The API is not enabled in the service account's Cloud project.
const DISABLED_REASONS = /^(accessNotConfigured|SERVICE_DISABLED)$/;

/** The kind of failure an HTTP answer means. Exported for tests. */
export function classify(httpStatus: number, body: unknown): GoogleApiError {
  const { message, status, reasons } = readError(body);
  const text = message || `HTTP ${httpStatus}`;
  if (httpStatus === 429 || status === 'RESOURCE_EXHAUSTED' || reasons.some((r) => QUOTA_REASONS.test(r))) {
    return new GoogleApiError('quota', `Google's request quota was reached: ${short(text)}`, httpStatus, null, status || null);
  }
  if (httpStatus === 401 || status === 'UNAUTHENTICATED') return new GoogleApiError('auth-failed', `Google did not accept the credentials: ${short(text)}`, httpStatus, null, status || null);
  if (reasons.some((r) => DISABLED_REASONS.test(r))) {
    return new GoogleApiError('api-disabled', `The API is not enabled in the service account's Google Cloud project: ${short(text)}`, httpStatus, null, status || null);
  }
  if (httpStatus === 403 || status === 'PERMISSION_DENIED') {
    return new GoogleApiError('permission-denied', `The service account has no access: ${short(text)}`, httpStatus, null, status || null);
  }
  if (httpStatus === 404 || status === 'NOT_FOUND') return new GoogleApiError('not-found', `Not found: ${short(text)}`, httpStatus, null, status || null);
  if (httpStatus === 400 || status === 'INVALID_ARGUMENT' || status === 'FAILED_PRECONDITION') {
    return new GoogleApiError('invalid-request', `Google refused the request: ${short(text)}`, httpStatus, null, status || null);
  }
  return new GoogleApiError('unavailable', `Google answered HTTP ${httpStatus}: ${short(text)}`, httpStatus, null, status || null);
}

function retryAfterMs(res: Response, now: number): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  /** JSON body (POST). */
  json?: unknown;
  /** Form body (the token endpoint). */
  form?: Record<string, string>;
  accessToken?: string;
}

/** One JSON request to Google with deadline, retries and safe errors. Returns the parsed body. */
export async function googleRequest(url: string, opts: RequestOptions, deps: GoogleDeps = googleDeps()): Promise<unknown> {
  const started = deps.now();
  let lastError: GoogleApiError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const headers: Record<string, string> = { accept: 'application/json' };
    let body: string | undefined;
    if (opts.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(opts.form).toString();
    } else if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    if (opts.accessToken) headers.authorization = `Bearer ${opts.accessToken}`;

    let res: Response;
    try {
      res = await deps.fetch(url, {
        method: opts.method ?? (body ? 'POST' : 'GET'),
        headers,
        body,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
      lastError = timedOut
        ? new GoogleApiError('timeout', `Google did not answer within ${ATTEMPT_TIMEOUT_MS / 1000} s.`)
        : new GoogleApiError('unavailable', 'Google could not be reached.');
      if (attempt < MAX_ATTEMPTS && deps.now() - started + backoff(attempt) + ATTEMPT_TIMEOUT_MS / 2 < OVERALL_BUDGET_MS) {
        await deps.sleep(backoff(attempt));
        continue;
      }
      throw lastError;
    }

    let parsed: unknown = null;
    let text: string;
    try {
      // The deadline also covers reading the body.
      text = await res.text();
    } catch (err) {
      const timedOut = (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
      throw timedOut
        ? new GoogleApiError('timeout', `Google did not answer within ${ATTEMPT_TIMEOUT_MS / 1000} s.`, res.status)
        : new GoogleApiError('unavailable', 'Google’s answer was cut off.', res.status);
    }
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (res.ok) {
      if (parsed === null && text) throw new GoogleApiError('bad-response', 'Google answered with something other than JSON.', res.status);
      return parsed ?? {};
    }

    lastError = classify(res.status, parsed);
    const wait = retryAfterMs(res, deps.now());
    const delay = wait ?? backoff(attempt);
    // Server errors only: a quota answer, even one sent as a 5xx, is never retried here.
    const retryable = RETRYABLE.has(res.status) && lastError.kind === 'unavailable';
    if (retryable && delay <= MAX_RETRY_AFTER_MS && attempt < MAX_ATTEMPTS && deps.now() - started + delay + ATTEMPT_TIMEOUT_MS / 2 < OVERALL_BUDGET_MS) {
      await deps.sleep(delay);
      continue;
    }
    throw new GoogleApiError(lastError.kind, lastError.safeMessage, res.status, wait !== null ? Math.ceil(wait / 1000) : null, lastError.code);
  }
  throw lastError ?? new GoogleApiError('unavailable', 'Google could not be reached.');
}

/** Exponential backoff with jitter: about 0.5 s, then 1 s. */
function backoff(attempt: number): number {
  const base = 500 * 2 ** (attempt - 1);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/** Any error from a call, as a GoogleApiError (shape problems become `bad-response`). */
export function toGoogleError(err: unknown): GoogleApiError {
  if (err instanceof GoogleApiError) return err;
  if (err instanceof ResponseShapeError) return new GoogleApiError('bad-response', `Google's answer was not in the expected form (${err.path}).`);
  return new GoogleApiError('unavailable', 'The request to Google failed.');
}

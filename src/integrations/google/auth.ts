import crypto from 'node:crypto';
import { GoogleApiError, googleDeps, googleRequest, type GoogleDeps } from './http';
import { parse, v } from './schema';
import type { ServiceAccount } from './config';

/**
 * Access tokens for the service account, by the OAuth 2.0 JWT bearer flow
 * (RFC 7523): a short JWT signed with the account's private key is exchanged
 * at Google's token endpoint for an access token limited to one read-only
 * scope. No Google client library is needed for this.
 *
 * Tokens live in this process's memory until a minute before they expire —
 * never in Redis, the database, a log line or a response. Nothing persists, so
 * there is nothing to encrypt or rotate here; rotating means replacing the
 * key in the environment (see the setup guide).
 */

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SCOPES = {
  searchConsole: 'https://www.googleapis.com/auth/webmasters.readonly',
  analytics: 'https://www.googleapis.com/auth/analytics.readonly',
} as const;

/** Lifetime asked for; Google allows at most one hour after `iat`. */
const TOKEN_LIFETIME_S = 3600;
const REFRESH_MARGIN_MS = 60_000;
/** `iat` is set this far back, so a server clock slightly ahead of Google's is not refused. */
export const CLOCK_SKEW_S = 30;

const tokens = new Map<string, { token: string; expiresAt: number }>();
/** Token requests in progress: concurrent requests on one instance share a single exchange. */
const pending = new Map<string, Promise<string>>();

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/** The signed assertion for one scope. Exported for tests, which verify the signature with the public key. */
export function signAssertion(account: ServiceAccount, scope: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - CLOCK_SKEW_S;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: account.email, scope, aud: TOKEN_URL, iat, exp: iat + TOKEN_LIFETIME_S };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.privateKey);
  return `${unsigned}.${b64url(signature)}`;
}

const tokenResponse = v.object({ access_token: v.string(), expires_in: v.optional(v.number()), token_type: v.optional(v.string()) });

// Token-endpoint errors (RFC 6749 §5.2), by Google's `error` string — Google
// documents no HTTP status per error, so the string is what to branch on.
const TOKEN_ERRORS = new Set(['invalid_grant', 'invalid_client', 'disabled_client', 'deleted_client', 'invalid_scope', 'unauthorized_client', 'org_internal', 'invalid_request']);

/** What to check, for the token errors Google documents (and "account not found", which it returns for an unknown account). */
function tokenHint(code: string, message: string): string {
  if (code === 'invalid_grant' && /account not found/i.test(message)) {
    return 'Check GOOGLE_SERVICE_ACCOUNT_EMAIL: Google has no service account with that address, or it was deleted.';
  }
  if (code === 'invalid_grant' && /signature/i.test(message)) {
    return 'The key does not belong to this service account, or it was disabled or deleted in Google Cloud. Create a new key and replace GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.';
  }
  if (code === 'invalid_grant' && /short-lived|timeframe/i.test(message)) {
    return "The API server's clock is out of step with Google's.";
  }
  if (code === 'disabled_client') return 'This key is disabled in Google Cloud. Enable it or create a new one.';
  if (code === 'deleted_client') return 'The service account was deleted in Google Cloud.';
  return 'Check the key is current and has not been deleted or disabled in Google Cloud.';
}

async function requestToken(account: ServiceAccount, scope: string, key: string, deps: GoogleDeps): Promise<string> {
  let body: unknown;
  try {
    body = await googleRequest(
      TOKEN_URL,
      { form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signAssertion(account, scope, deps.now()) } },
      deps,
    );
  } catch (err) {
    if (err instanceof GoogleApiError && ((err.code && TOKEN_ERRORS.has(err.code)) || err.httpStatus === 400 || err.httpStatus === 401)) {
      const google = err.safeMessage.replace(/^Google refused the request: |^Google did not accept the credentials: |^Google answered HTTP \d+: /, '');
      throw new GoogleApiError(
        'auth-failed',
        `Google did not accept the service account key (${google}). ${tokenHint(err.code ?? '', google)}`,
        err.httpStatus,
        null,
        err.code,
      );
    }
    throw err;
  }
  const parsed = parse(tokenResponse, body);
  const lifetime = (parsed.expires_in ?? TOKEN_LIFETIME_S) * 1000;
  tokens.set(key, { token: parsed.access_token, expiresAt: deps.now() + lifetime });
  return parsed.access_token;
}

export async function accessToken(account: ServiceAccount, scope: string, deps: GoogleDeps = googleDeps()): Promise<string> {
  const key = `${account.email}\u0000${scope}`;
  const cached = tokens.get(key);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > deps.now()) return cached.token;
  let inflight = pending.get(key);
  if (!inflight) {
    inflight = requestToken(account, scope, key, deps).finally(() => pending.delete(key));
    pending.set(key, inflight);
  }
  return inflight;
}

/** Tests only: forget cached tokens. */
export function clearTokenCache(): void {
  tokens.clear();
  pending.clear();
}

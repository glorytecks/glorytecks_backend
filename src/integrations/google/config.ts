import crypto from 'node:crypto';
import { env } from '../../config/env';

/**
 * Configuration for the read-only Google integrations, checked on use.
 *
 * One Google service account, shared with the Search Console property and the
 * GA4 property, signs every request (see auth.ts). Nothing is checked at boot:
 * a missing or malformed value turns the analytics screens off and says which
 * variable to fix, while the rest of the API runs as usual.
 *
 * Problems name variables, never values. The private key is parsed into a
 * KeyObject here and goes nowhere else but the signer.
 */

export type Provider = 'search-console' | 'analytics';

export interface ServiceAccount {
  email: string;
  privateKey: crypto.KeyObject;
}

export type ConfigState<T> =
  | { state: 'configured'; value: T }
  | { state: 'not-configured'; missing: string[] }
  | { state: 'invalid'; problems: string[] };

export interface SearchConsoleConfig {
  account: ServiceAccount;
  /** As Search Console names the property: `sc-domain:example.com` or `https://example.com/`. */
  siteUrl: string;
}

export interface AnalyticsConfig {
  account: ServiceAccount;
  /** The numeric GA4 property id. */
  propertyId: string;
}

const EMAIL_VAR = 'GOOGLE_SERVICE_ACCOUNT_EMAIL';
const KEY_VAR = 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY';
const SITE_VAR = 'GSC_SITE_URL';
const PROPERTY_VAR = 'GA4_PROPERTY_ID';

export const ENV_VARS: Record<Provider, string[]> = {
  'search-console': [EMAIL_VAR, KEY_VAR, SITE_VAR],
  analytics: [EMAIL_VAR, KEY_VAR, PROPERTY_VAR],
};

const SERVICE_ACCOUNT_EMAIL = /^[a-z0-9][a-z0-9._-]*@[a-z0-9-]+(\.[a-z0-9-]+)*\.gserviceaccount\.com$/i;
const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Hosting dashboards store a PEM key either with real line breaks or with the
 * two characters `\n`, sometimes wrapped in quotes. Accept both.
 */
export function normalisePrivateKey(raw: string): string {
  let key = raw.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
  if (!key.includes('\n') && key.includes('\\n')) key = key.replace(/\\n/g, '\n');
  return key;
}

// Parsing a key costs a little; remember the last one by a digest of its text.
let parsedKey: { digest: string; key: crypto.KeyObject | null; problem: string | null } | null = null;

function parsePrivateKey(raw: string): { key: crypto.KeyObject } | { problem: string } {
  const digest = crypto.createHash('sha256').update(raw).digest('hex');
  if (parsedKey?.digest !== digest) {
    let key: crypto.KeyObject | null = null;
    let problem: string | null = null;
    const pem = normalisePrivateKey(raw);
    if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem)) {
      problem = `${KEY_VAR} is not a PEM private key. Paste the "private_key" value from the service account's JSON key file, including the BEGIN and END lines.`;
    } else {
      try {
        key = crypto.createPrivateKey({ key: pem, format: 'pem' });
        if (key.asymmetricKeyType !== 'rsa') {
          key = null;
          problem = `${KEY_VAR} is not an RSA key. Google service account keys are RSA; use the key file Google generated.`;
        }
      } catch {
        problem = `${KEY_VAR} could not be read as a private key. Paste the "private_key" value from the JSON key file exactly, line breaks included (or as \\n).`;
      }
    }
    parsedKey = { digest, key, problem };
  }
  return parsedKey.key ? { key: parsedKey.key } : { problem: parsedKey.problem ?? `${KEY_VAR} could not be read.` };
}

function serviceAccount(): ConfigState<ServiceAccount> {
  const email = env.google.serviceAccountEmail;
  const rawKey = env.google.serviceAccountPrivateKey;
  const missing = [!email && EMAIL_VAR, !rawKey.trim() && KEY_VAR].filter((v): v is string => Boolean(v));
  if (missing.length) return { state: 'not-configured', missing };
  const problems: string[] = [];
  if (!SERVICE_ACCOUNT_EMAIL.test(email)) {
    problems.push(`${EMAIL_VAR} is not a service account address (it ends in .gserviceaccount.com).`);
  }
  const parsed = parsePrivateKey(rawKey);
  if ('problem' in parsed) problems.push(parsed.problem);
  if (problems.length || !('key' in parsed)) return { state: 'invalid', problems };
  return { state: 'configured', value: { email: email.toLowerCase(), privateKey: parsed.key } };
}

/** Validate GSC_SITE_URL: a domain property or a URL-prefix property, exactly as Search Console writes it. */
export function parseSiteUrl(raw: string): { ok: true; siteUrl: string } | { ok: false; problem: string } {
  const value = raw.trim();
  if (value.toLowerCase().startsWith('sc-domain:')) {
    const host = value.slice('sc-domain:'.length).toLowerCase();
    return HOST.test(host) ? { ok: true, siteUrl: `sc-domain:${host}` } : { ok: false, problem: `${SITE_VAR} must look like sc-domain:example.com for a domain property.` };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, problem: `${SITE_VAR} must be sc-domain:example.com (domain property) or https://example.com/ (URL-prefix property).` };
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
    return { ok: false, problem: `${SITE_VAR} must be an http(s) address with no credentials, query or fragment.` };
  }
  if (!value.endsWith('/')) {
    return { ok: false, problem: `${SITE_VAR} must end with "/" for a URL-prefix property, exactly as Search Console shows it.` };
  }
  return { ok: true, siteUrl: url.href };
}

/** Validate GA4_PROPERTY_ID: the numeric property id, or properties/<id>. */
export function parsePropertyId(raw: string): { ok: true; propertyId: string } | { ok: false; problem: string } {
  const match = /^(?:properties\/)?(\d{5,15})$/.exec(raw.trim());
  return match
    ? { ok: true, propertyId: match[1] }
    : { ok: false, problem: `${PROPERTY_VAR} must be the numeric GA4 property id (Admin → Property details), not the G- measurement id.` };
}

function combine<T>(account: ConfigState<ServiceAccount>, own: { var: string; raw: string; parse: () => { ok: true; value: T } | { ok: false; problem: string } }) {
  const missing = account.state === 'not-configured' ? [...account.missing] : [];
  if (!own.raw.trim()) missing.push(own.var);
  if (missing.length) return { state: 'not-configured' as const, missing };
  const problems = account.state === 'invalid' ? [...account.problems] : [];
  const parsed = own.parse();
  if (!parsed.ok) problems.push(parsed.problem);
  if (problems.length || account.state !== 'configured' || !parsed.ok) return { state: 'invalid' as const, problems };
  return { state: 'configured' as const, account: account.value, value: parsed.value };
}

export function searchConsoleConfig(): ConfigState<SearchConsoleConfig> {
  const raw = env.google.searchConsoleSiteUrl;
  const result = combine(serviceAccount(), {
    var: SITE_VAR,
    raw,
    parse: () => {
      const r = parseSiteUrl(raw);
      return r.ok ? { ok: true as const, value: r.siteUrl } : r;
    },
  });
  return result.state === 'configured' ? { state: 'configured', value: { account: result.account, siteUrl: result.value } } : result;
}

export function analyticsConfig(): ConfigState<AnalyticsConfig> {
  const raw = env.google.ga4PropertyId;
  const result = combine(serviceAccount(), {
    var: PROPERTY_VAR,
    raw,
    parse: () => {
      const r = parsePropertyId(raw);
      return r.ok ? { ok: true as const, value: r.propertyId } : r;
    },
  });
  return result.state === 'configured' ? { state: 'configured', value: { account: result.account, propertyId: result.value } } : result;
}

/** What the admin may see about the configuration: identifiers and variable names, never the key. */
export function publicConfig(provider: Provider) {
  const email = env.google.serviceAccountEmail;
  const config = provider === 'search-console' ? searchConsoleConfig() : analyticsConfig();
  const site = parseSiteUrl(env.google.searchConsoleSiteUrl);
  const property = parsePropertyId(env.google.ga4PropertyId);
  return {
    state: config.state,
    missing: config.state === 'not-configured' ? config.missing : [],
    problems: config.state === 'invalid' ? config.problems : [],
    envVars: ENV_VARS[provider],
    // Identifiers the setup steps need; shown only when they are well formed.
    serviceAccountEmail: SERVICE_ACCOUNT_EMAIL.test(email) ? email.toLowerCase() : null,
    identifier:
      provider === 'search-console' ? (site.ok ? site.siteUrl : null) : property.ok ? property.propertyId : null,
  };
}

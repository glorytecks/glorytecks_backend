import net from 'node:net';
import { env } from '../../config/env';
import { PRODUCTION_ORIGIN } from '../site/canonical';
import { isVercelAppHost } from '../site/smoke';

/**
 * Where the technical SEO audit may go, and how hard it may push.
 *
 * The audit crawls one origin, named explicitly in SEO_AUDIT_ORIGIN. Nothing a
 * request carries can change it: the admin starts a run, it never supplies a
 * URL. The origin must be the production site, a subdomain of it, or a
 * *.vercel.app deployment of it; anything else leaves the audit switched off
 * and the admin says why.
 */

const PRODUCTION_HOST = new URL(PRODUCTION_ORIGIN).hostname;
const PRODUCTION_HOSTS = [PRODUCTION_HOST, `www.${PRODUCTION_HOST}`];

export interface AuditConfig {
  origin: string;
  /** Hosts pages may be requested from: the origin and its www/apex twin. */
  pageHosts: string[];
  /** Hosts whose links count as internal: the page hosts and the production hosts (sitemaps and links use those). */
  linkHosts: string[];
  /** Hosts images may be checked on: the page hosts and the upload media hosts. */
  mediaHosts: string[];
  /** The origin is the production site, so robots.txt must invite crawling. */
  production: boolean;
  /** A *.vercel.app deployment: every response must carry X-Robots-Tag: noindex. */
  hostNoindex: boolean;
  maxPages: number;
  /** Time one step may spend starting requests and writing results. */
  stepMs: number;
  /** Per-request deadline. */
  timeoutMs: number;
  /** Requests in flight at once. */
  concurrency: number;
  /** Tries per URL before it is recorded as failed. */
  attempts: number;
  /** Minimum time between the end of one completed run and the start of the next. */
  cooldownMs: number;
}

export type AuditConfigState =
  | { ok: true; config: AuditConfig }
  | { ok: false; reason: string; setup: string };

const SETUP =
  'Set SEO_AUDIT_ORIGIN on the backend to the site origin to audit, e.g. https://glorytecks.com, and redeploy. ' +
  'Optional: SEO_AUDIT_MAX_PAGES (default 300, at most 1000) and SEO_AUDIT_STEP_MS (default 8000).';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const intFrom = (raw: string, fallback: number) => {
  const n = Number(raw);
  return raw && Number.isFinite(n) ? Math.round(n) : fallback;
};

/** Is this host one the audit may treat as the site? */
export function isOwnedHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === PRODUCTION_HOST || h.endsWith(`.${PRODUCTION_HOST}`) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/.test(h);
}

/** Validate SEO_AUDIT_ORIGIN. Exported for tests. */
export function parseAuditOrigin(raw: string | undefined): { ok: true; origin: string; host: string } | { ok: false; reason: string } {
  const value = raw?.trim() ?? '';
  if (!value) return { ok: false, reason: 'SEO_AUDIT_ORIGIN is not set.' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'SEO_AUDIT_ORIGIN is not a valid URL.' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'SEO_AUDIT_ORIGIN must use https.' };
  if (url.username || url.password || url.port) {
    return { ok: false, reason: 'SEO_AUDIT_ORIGIN must not carry credentials or a port.' };
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    return { ok: false, reason: 'SEO_AUDIT_ORIGIN must be an origin only, with no path or query.' };
  }
  const host = url.hostname.toLowerCase();
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) return { ok: false, reason: 'SEO_AUDIT_ORIGIN must be a host name, not an IP address.' };
  if (!isOwnedHost(host)) {
    return {
      ok: false,
      reason: `SEO_AUDIT_ORIGIN must be ${PRODUCTION_ORIGIN}, one of its subdomains, or a *.vercel.app deployment of the site.`,
    };
  }
  return { ok: true, origin: `https://${host}`, host };
}

export function auditConfig(): AuditConfigState {
  const parsed = parseAuditOrigin(env.seoAudit.origin);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, setup: SETUP };

  const { origin, host } = parsed;
  const twin = host === PRODUCTION_HOST ? `www.${host}` : host === `www.${PRODUCTION_HOST}` ? PRODUCTION_HOST : null;
  const pageHosts = twin ? [host, twin] : [host];
  const stepMs = clamp(intFrom(env.seoAudit.stepMs, 8000), 4000, 25_000);

  return {
    ok: true,
    config: {
      origin,
      pageHosts,
      linkHosts: [...new Set([...pageHosts, ...PRODUCTION_HOSTS])],
      mediaHosts: [...new Set([...pageHosts, ...env.upload.mediaHosts.map((h) => h.toLowerCase())])],
      production: PRODUCTION_HOSTS.includes(host),
      hostNoindex: isVercelAppHost(origin),
      maxPages: clamp(intFrom(env.seoAudit.maxPages, 300), 10, 1000),
      stepMs,
      timeoutMs: Math.min(5000, Math.floor(stepMs / 2)),
      concurrency: 3,
      attempts: 3,
      cooldownMs: 10 * 60 * 1000,
    },
  };
}

import { accessToken, SCOPES } from './auth';
import { googleDeps, googleRequest, type GoogleDeps } from './http';
import { parse, v } from './schema';
import type { SearchConsoleConfig } from './config';

/**
 * Search Console API (webmasters v3), read-only: the property's details and
 * Search Analytics queries. Nothing here can change the property — and there
 * is no API to request indexing for ordinary pages, so the admin links to the
 * Search Console UI for that instead of pretending.
 */

const BASE = 'https://searchconsole.googleapis.com/webmasters/v3';

const siteUrlPath = (siteUrl: string) => `${BASE}/sites/${encodeURIComponent(siteUrl)}`;

/** Levels that can read the Performance report. Restricted is the least that can. */
export const READ_LEVELS = ['siteOwner', 'siteFullUser', 'siteRestrictedUser'] as const;

const siteResponse = v.object({ siteUrl: v.string(), permissionLevel: v.string() });

/** The reference spells levels siteRestrictedUser; the discovery document SITE_RESTRICTED_USER. */
export const normaliseLevel = (raw: string): string =>
  /^[A-Z_]+$/.test(raw) ? raw.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) : raw;

/** The property as Google sees it, and the service account's permission on it. */
export async function getSite(config: SearchConsoleConfig, deps: GoogleDeps = googleDeps()) {
  const token = await accessToken(config.account, SCOPES.searchConsole, deps);
  const site = parse(siteResponse, await googleRequest(siteUrlPath(config.siteUrl), { method: 'GET', accessToken: token }, deps));
  return { siteUrl: site.siteUrl, permissionLevel: normaliseLevel(site.permissionLevel) };
}

export type GscDimension = 'date' | 'query' | 'page' | 'country' | 'device';

export interface GscQuery {
  startDate: string;
  endDate: string;
  dimensions: GscDimension[];
  rowLimit: number;
  /** 'final' (default): complete days only. 'all': includes the newest, still-changing data. */
  dataState?: 'final' | 'all';
}

export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

const queryResponse = v.object({
  rows: v.array(
    v.object({
      keys: v.optional(v.array(v.string())),
      clicks: v.number(),
      impressions: v.number(),
      ctr: v.number(),
      position: v.number(),
    }),
  ),
  responseAggregationType: v.optional(v.string()),
});

/** One Search Analytics query: web search results only, aggregated as Search Console does by default. */
export async function searchAnalytics(config: SearchConsoleConfig, q: GscQuery, deps: GoogleDeps = googleDeps()): Promise<GscRow[]> {
  const token = await accessToken(config.account, SCOPES.searchConsole, deps);
  const body = await googleRequest(
    `${siteUrlPath(config.siteUrl)}/searchAnalytics/query`,
    {
      method: 'POST',
      accessToken: token,
      json: {
        startDate: q.startDate,
        endDate: q.endDate,
        dimensions: q.dimensions,
        type: 'web',
        rowLimit: q.rowLimit,
        dataState: q.dataState ?? 'final',
      },
    },
    deps,
  );
  return parse(queryResponse, body).rows.map((r) => ({ ...r, keys: r.keys ?? [] }));
}

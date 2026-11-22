import { accessToken, SCOPES } from './auth';
import { googleDeps, googleRequest, type GoogleDeps } from './http';
import { parse, v } from './schema';
import type { AnalyticsConfig } from './config';

/**
 * Google Analytics 4, read-only: the Data API for reports and the Admin API
 * for the property's own list of key events. Metric and dimension names are
 * the Data API's; key events are whatever the property has marked — nothing
 * is assumed.
 */

const DATA_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const ADMIN_BASE = 'https://analyticsadmin.googleapis.com/v1beta';

export interface Ga4DateRange {
  startDate: string;
  endDate: string;
  name?: string;
}

export interface Ga4ReportRequest {
  dateRanges: Ga4DateRange[];
  dimensions?: string[];
  metrics: string[];
  limit?: number;
  orderByMetric?: string;
  /** Keep only these values of a dimension (e.g. eventName in the key events). */
  inList?: { dimension: string; values: string[] };
}

export interface Ga4Row {
  dimensions: string[];
  metrics: number[];
}

/** What Google says about the numbers themselves. */
export interface Ga4Quality {
  /** Rows were withheld to protect user privacy (Google's data thresholds). */
  thresholded: boolean;
  /** The report was computed from a sample. */
  sampled: boolean;
  /** Some rows were grouped into "(other)" because the table hit its row limit. */
  otherRow: boolean;
}

export interface Ga4Report {
  dimensionHeaders: string[];
  metricHeaders: string[];
  rows: Ga4Row[];
  /** Rows in the whole result, regardless of the limit. */
  rowCount: number;
  timeZone: string | null;
  quality: Ga4Quality;
}

// ProtoJSON leaves out empty lists and default values, so almost everything is optional.
const reportResponse = v.object({
  dimensionHeaders: v.array(v.object({ name: v.string() })),
  metricHeaders: v.array(v.object({ name: v.string(), type: v.optional(v.string()) })),
  rows: v.array(
    v.object({
      dimensionValues: v.array(v.object({ value: v.optional(v.string()) })),
      metricValues: v.array(v.object({ value: v.numericString() })),
    }),
  ),
  rowCount: v.optional(v.number()),
  metadata: v.optional(
    v.object({
      timeZone: v.optional(v.string()),
      subjectToThresholding: v.optional(v.boolean()),
      dataLossFromOtherRow: v.optional(v.boolean()),
      samplingMetadatas: v.array(v.object({})),
    }),
  ),
});

const requestBody = (req: Ga4ReportRequest) => ({
  dateRanges: req.dateRanges,
  dimensions: (req.dimensions ?? []).map((name) => ({ name })),
  metrics: req.metrics.map((name) => ({ name })),
  limit: String(req.limit ?? 100),
  ...(req.orderByMetric ? { orderBys: [{ metric: { metricName: req.orderByMetric }, desc: true }] } : {}),
  ...(req.inList ? { dimensionFilter: { filter: { fieldName: req.inList.dimension, inListFilter: { values: req.inList.values } } } } : {}),
});

function toReport(raw: unknown): Ga4Report {
  const r = parse(reportResponse, raw);
  return {
    dimensionHeaders: r.dimensionHeaders.map((h) => h.name),
    metricHeaders: r.metricHeaders.map((h) => h.name),
    rows: r.rows.map((row) => ({ dimensions: row.dimensionValues.map((d) => d.value ?? ''), metrics: row.metricValues.map((m) => m.value) })),
    rowCount: r.rowCount ?? r.rows.length,
    timeZone: r.metadata?.timeZone ?? null,
    quality: {
      thresholded: r.metadata?.subjectToThresholding ?? false,
      sampled: (r.metadata?.samplingMetadatas.length ?? 0) > 0,
      otherRow: r.metadata?.dataLossFromOtherRow ?? false,
    },
  };
}

export async function runReport(config: AnalyticsConfig, req: Ga4ReportRequest, deps: GoogleDeps = googleDeps()): Promise<Ga4Report> {
  const token = await accessToken(config.account, SCOPES.analytics, deps);
  const body = await googleRequest(
    `${DATA_BASE}/properties/${config.propertyId}:runReport`,
    { method: 'POST', accessToken: token, json: requestBody(req) },
    deps,
  );
  return toReport(body);
}

/** Up to five reports in one request: one request against the property's concurrency limit instead of five. */
export const MAX_BATCH = 5;

const batchResponse = v.object({ reports: v.array((x) => x) });

export async function batchRunReports(config: AnalyticsConfig, reqs: Ga4ReportRequest[], deps: GoogleDeps = googleDeps()): Promise<Ga4Report[]> {
  if (reqs.length === 0 || reqs.length > MAX_BATCH) throw new Error(`batchRunReports takes 1–${MAX_BATCH} reports`);
  const token = await accessToken(config.account, SCOPES.analytics, deps);
  const body = await googleRequest(
    `${DATA_BASE}/properties/${config.propertyId}:batchRunReports`,
    { method: 'POST', accessToken: token, json: { requests: reqs.map(requestBody) } },
    deps,
  );
  const { reports } = parse(batchResponse, body);
  if (reports.length !== reqs.length) throw new Error(`batchRunReports answered ${reports.length} reports for ${reqs.length} requests`);
  return reports.map(toReport);
}

const keyEventsResponse = v.object({
  keyEvents: v.array(v.object({ eventName: v.string(), countingMethod: v.optional(v.string()) })),
  nextPageToken: v.optional(v.string()),
});

export interface KeyEvent {
  eventName: string;
  /** ONCE_PER_EVENT or ONCE_PER_SESSION. */
  countingMethod: string | null;
}

/** The events the property has marked as key events (Admin → Data display → Events). */
export async function listKeyEvents(config: AnalyticsConfig, deps: GoogleDeps = googleDeps()): Promise<KeyEvent[]> {
  const token = await accessToken(config.account, SCOPES.analytics, deps);
  const out: KeyEvent[] = [];
  let pageToken: string | undefined;
  // A standard property can mark at most 30; one page of 200 is plenty, three is a safety net.
  for (let page = 0; page < 3; page++) {
    const url = `${ADMIN_BASE}/properties/${config.propertyId}/keyEvents?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const r = parse(keyEventsResponse, await googleRequest(url, { method: 'GET', accessToken: token }, deps));
    out.push(...r.keyEvents.map((k) => ({ eventName: k.eventName, countingMethod: k.countingMethod ?? null })));
    if (!r.nextPageToken) break;
    pageToken = r.nextPageToken;
  }
  return out;
}

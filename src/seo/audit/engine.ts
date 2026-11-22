import { randomUUID } from 'node:crypto';
import { siteAuditIssueRepo, siteAuditPageRepo, siteAuditRunRepo } from '../../repositories';
import type { BaseRepository, Filter } from '../../repositories/BaseRepository';
import type { ISiteAuditPage, ISiteAuditRun, SiteAuditPhase, SiteAuditRunStatus } from '../../interfaces/common';
import { checkAuditUrl, FetchFailure, type FetchOptions, type FetchResult, type Transport } from '../../lib/safeHttp';
import { canonicalUrlFor, PRODUCTION_ORIGIN } from '../site/canonical';
import { checkRobotsTxt, checkSitemapHygiene, checkSitemapIndex, checkUrlset, sitemapLocs } from '../site/smoke';
import { followRedirects } from '../site/pageAudit';
import { crawlable } from '../site/sitecrawl';
import type { TextSource } from '../pageChecks';
import { AUDIT_ROBOTS_TOKEN, parseRobots, robotsAllows, type RobotsPolicy } from './robots';
import { readPage, type PageRecord, type ReadPage, type StoredLink } from './extract';
import { analyze, evaluationOf, fingerprint, isEvaluated, type AuditRow, type Hop, type SiteChecks } from './analyze';
import { planLifecycle, type KeyedFinding, type StoredIssue } from './lifecycle';
import type { AuditConfig } from './config';

/**
 * The audit's step machine.
 *
 * The backend runs as Vercel serverless functions: work left running after a
 * response is sent is frozen or discarded, so a crawl cannot be a background
 * task. A run is a row in site_audit_runs instead, and each POST …/step does
 * one short slice of it and saves where it got to:
 *
 *   discover  robots.txt, /sitemap.xml and each child sitemap; then the URLs
 *             to check — the route registry and published CMS records, then
 *             every sitemap URL — up to the page budget
 *   crawl     pages, read with the site's checks; the internal links and
 *             images they hold are queued as they are found
 *   links     link targets that are not pages (filters, over-budget pages): status only
 *   images    images on approved hosts: status only (HEAD)
 *   analyze   findings, then the issue history (lifecycle.ts)
 *
 * A step first takes the run's lease (a compare-and-set on lease_until), so
 * two browsers cannot advance one run at once; every write it makes is
 * conditional on still holding that lease and the run still running, so a
 * cancel takes effect at the next write. A step that dies — function timeout,
 * deploy — leaves its lease to expire and its URLs pending; the next step
 * picks them up.
 *
 * A step starts new requests only while one more full request timeout still
 * fits in its time budget, so it ends within SEO_AUDIT_STEP_MS plus the time
 * its database writes take.
 */

/* ── Wiring ───────────────────────────────────────────────────────────────── */

export interface Seed {
  path: string;
  source: string;
  /** Should answer 200: a registry page or a published record. */
  live: boolean;
  expectIndex: boolean | null;
  expectFollow: boolean | null;
  /** Lower is crawled first, and kept first when the budget runs out. */
  priority: number;
}

/** What the CMS knows: the URLs to start from, and where each page is edited. */
export interface AuditContext {
  seeds: Seed[];
  textSources: Map<string, { title: TextSource; description: TextSource }>;
  adminPathFor: (path: string) => string | null;
}

export interface EngineDeps {
  transport: Transport;
  now: () => number;
  context: () => Promise<AuditContext>;
}

/* ── Run state ────────────────────────────────────────────────────────────── */

interface FileRead {
  status: number | null;
  error: string | null;
  attempts: number;
  done: boolean;
}

type RobotsMode = 'rules' | 'allow-all' | 'unreadable';

interface RunState {
  robots?: FileRead & { text: string | null; mode?: RobotsMode };
  index?: FileRead & { children: string[]; failures: string[] };
  children?: Record<string, FileRead & { failures: string[]; xml?: string }>;
  site?: SiteChecks;
  sitemapsComplete?: boolean;
  /** robots.txt of each media host images were checked on. */
  hostRobots?: Record<string, FileRead & { text: string | null; mode?: RobotsMode }>;
  /** Hosts serving images the audit may not request (not on the approved list). */
  externalImageHosts?: string[];
}

export interface RunProgress {
  page: Record<'pending' | 'done' | 'failed' | 'skipped', number>;
  link: Record<'pending' | 'done' | 'failed' | 'skipped', number>;
  image: Record<'pending' | 'done' | 'failed' | 'skipped', number>;
}

export interface RunCoverage {
  /** Every page and link target found was answered and every sitemap read. */
  complete: boolean;
  imagesComplete: boolean;
  sitemaps: 'pending' | 'complete' | 'partial' | 'unavailable';
  /** URLs found but not checked because the page budget was spent. */
  budgetSkipped: number;
  /** URLs robots.txt does not allow this crawler to request. */
  robotsSkipped: number;
  /** URLs that never answered after every attempt. */
  failed: number;
  externalImageHosts: string[];
}

const EPOCH = new Date(0).toISOString();
/** Time kept back at the end of a step for its database writes. */
const RESERVE_MS = 1200;
/** A step's lease outlives its budget by this much before another step may take over. */
const LEASE_GRACE_MS = 20_000;
export const BUDGET_SKIP = 'over the page budget';
export const ROBOTS_SKIP = 'robots.txt disallows the audit crawler here';
const PAGE_BATCH = 40;
const STATUS_BATCH = 60;
const READ_PAGE_SIZE = 1000;
const ANALYZE_PAGE_SIZE = 200;
const MAX_URL_LENGTH = 2048;

export const RUN_VIEW_FIELDS = [
  'origin', 'status', 'phase', 'maxPages', 'steps', 'progress', 'coverage', 'summary', 'error',
  'startedAt', 'finishedAt', 'leaseUntil', 'createdAt', 'updatedAt',
];
const RUN_WORK_FIELDS = [...RUN_VIEW_FIELDS, 'state', 'leaseToken'];

const iso = (ms: number) => new Date(ms).toISOString();
const unique = <T>(list: readonly T[]) => [...new Set(list)];
const isHtml = (contentType: string) => /text\/html|application\/xhtml\+xml/i.test(contentType);

/** A site path (+ query) for a URL on one of `hosts`, or null. */
function sitePath(url: string, hosts: readonly string[]): string | null {
  try {
    const u = new URL(url);
    if (!hosts.includes(u.hostname.toLowerCase())) return null;
    const path = u.pathname + u.search;
    return path.length <= MAX_URL_LENGTH ? path : null;
  } catch {
    return null;
  }
}

/** Every row of a run (or any filter), read a page at a time — PostgREST caps one response at 1000 rows. */
export async function readAll<T>(repo: BaseRepository<T>, filter: Filter, fields: string[] | undefined, pageSize = READ_PAGE_SIZE): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const { items, total } = await repo.list({ filter, fields, page, limit: pageSize, sort: [{ field: 'id', direction: 1 }] });
    out.push(...items);
    if (items.length < pageSize || out.length >= total) return out;
  }
}

async function inChunks<T>(list: readonly T[], size: number, fn: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < list.length; i += size) await fn(list.slice(i, i + size));
}

/** Run `fn` over `items`, `width` at a time, starting each only while `canStart()` holds. */
async function pool<T>(items: readonly T[], width: number, canStart: () => boolean, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length && canStart()) await fn(items[next++]);
  });
  await Promise.all(lanes);
}

/* ── Known rows: what the run already holds, kept current during a step ──── */

interface KnownRow {
  kind: 'page' | 'link' | 'image';
  state: 'pending' | 'done' | 'failed' | 'skipped';
  skipReason: string | null;
}

class Known {
  private rows = new Map<string, KnownRow>();

  static key(kind: string, path: string) {
    return `${kind}\u0000${path}`;
  }

  static async load(runId: string): Promise<Known> {
    const k = new Known();
    for (const r of await readAll(siteAuditPageRepo, { runId }, ['kind', 'path', 'state', 'skipReason'])) {
      k.set(r.kind, r.path, { kind: r.kind, state: r.state, skipReason: r.skipReason ?? null });
    }
    return k;
  }

  has(kind: string, path: string) {
    return this.rows.has(Known.key(kind, path));
  }

  set(kind: string, path: string, row: KnownRow) {
    this.rows.set(Known.key(kind, path), row);
  }

  /** Rows of a kind that count against the budget (everything but budget skips). */
  used(kind: KnownRow['kind']): number {
    let n = 0;
    for (const r of this.rows.values()) if (r.kind === kind && r.skipReason !== BUDGET_SKIP) n++;
    return n;
  }

  progress(): RunProgress {
    const blank = () => ({ pending: 0, done: 0, failed: 0, skipped: 0 });
    const p: RunProgress = { page: blank(), link: blank(), image: blank() };
    for (const r of this.rows.values()) p[r.kind][r.state]++;
    return p;
  }

  skips(reason: string, kinds: KnownRow['kind'][] = ['page', 'link', 'image']): number {
    let n = 0;
    for (const r of this.rows.values()) if (kinds.includes(r.kind) && r.state === 'skipped' && r.skipReason === reason) n++;
    return n;
  }
}

/* ── One step ─────────────────────────────────────────────────────────────── */

/** The run is no longer ours: another step took the lease, or it was cancelled. */
class LeaseLost extends Error {}

class Step {
  readonly deadline: number;
  phase: SiteAuditPhase;
  status: SiteAuditRunStatus = 'running';
  state: RunState;
  error: string | null;
  summary: Record<string, unknown> | undefined;
  finishedAt: string | null = null;
  known: Known | null = null;
  private context: AuditContext | null = null;

  constructor(
    readonly run: ISiteAuditRun,
    readonly token: string,
    readonly config: AuditConfig,
    readonly deps: EngineDeps,
    readonly started: number,
  ) {
    this.deadline = started + config.stepMs;
    this.phase = run.phase;
    this.state = (run.state ?? {}) as RunState;
    this.error = run.error ?? null;
  }

  canStart(): boolean {
    return this.deps.now() + this.config.timeoutMs + RESERVE_MS <= this.deadline;
  }

  async ctx(): Promise<AuditContext> {
    this.context ??= await this.deps.context();
    return this.context;
  }

  async knownRows(): Promise<Known> {
    this.known ??= await Known.load(this.run.id);
    return this.known;
  }

  fail(reason: string) {
    this.status = 'failed';
    this.error = reason.slice(0, 300);
    this.finishedAt = iso(this.deps.now());
  }

  /** One request to an allowed host; anything else is refused before a socket opens. */
  async request(url: string, hosts: readonly string[], opts: FetchOptions = {}): Promise<FetchResult> {
    const check = checkAuditUrl(url, hosts);
    if (!check.ok) throw new FetchFailure(check.reason, false);
    return this.deps.transport.fetch(check.url.href, { timeoutMs: this.config.timeoutMs, ...opts });
  }

  /** The robots policy that applies to a host, or null when it is not known or not readable. */
  policyFor(host: string): RobotsPolicy | null {
    const h = host.toLowerCase();
    const entry = this.config.pageHosts.includes(h) ? this.state.robots : this.state.hostRobots?.[h];
    if (!entry?.done || !entry.mode || entry.mode === 'unreadable') return null;
    return entry.mode === 'rules' ? parseRobots(entry.text ?? '', AUDIT_ROBOTS_TOKEN) : { rules: [], sitemaps: [] };
  }

  allows(url: URL): boolean {
    const policy = this.policyFor(url.hostname);
    return policy !== null && robotsAllows(policy, url.pathname + url.search);
  }

  /**
   * Write to the run while still holding it. The lease is extended unless the
   * patch releases it (lease_until: EPOCH, lease_token: null).
   */
  async save(patch: Record<string, unknown>, fields = RUN_VIEW_FIELDS): Promise<ISiteAuditRun> {
    const [row] = await siteAuditRunRepo.updateWhereRaw(
      { id: this.run.id, leaseToken: this.token, status: 'running' },
      { lease_until: iso(this.deps.now() + this.config.stepMs + LEASE_GRACE_MS), ...patch },
      { fields },
    );
    if (!row) throw new LeaseLost();
    return row;
  }
}

/** Read a small site file (robots.txt, a sitemap), following redirects within `hosts`. */
async function readFile(
  step: Step,
  url: string,
  hosts: readonly string[],
  entry: FileRead,
  maxBytes: number,
  onAnswer: (res: FetchResult) => void,
): Promise<void> {
  const box: { last?: FetchResult } = {};
  try {
    const followed = await followRedirects(
      url,
      async (u) => {
        box.last = await step.request(u, hosts, { readBody: true, maxBytes });
        return { status: box.last.status, location: box.last.location };
      },
      5,
    );
    entry.done = true;
    if (followed.loop || !box.last) {
      entry.status = null;
      entry.error = 'redirect loop';
      return;
    }
    entry.status = box.last.status;
    entry.error = null;
    onAnswer(box.last);
  } catch (err) {
    if (!(err instanceof FetchFailure)) throw err;
    entry.attempts++;
    entry.error = err.reason;
    if (!err.transient || entry.attempts >= step.config.attempts) entry.done = true;
  }
}

/**
 * RFC 9309: 2xx → its rules; 4xx → no restrictions; anything else (5xx, no
 * answer) → assume nothing may be crawled. 429 is treated as unreadable, as
 * Google does: a server asking crawlers to slow down is not inviting one.
 */
const robotsModeOf = (status: number | null): RobotsMode =>
  status === 200 ? 'rules' : status !== null && status >= 400 && status < 500 && status !== 429 ? 'allow-all' : 'unreadable';

/* ── discover ─────────────────────────────────────────────────────────────── */

async function discover(step: Step): Promise<void> {
  const { config, state } = step;

  state.robots ??= { status: null, error: null, attempts: 0, done: false, text: null };
  const robots = state.robots;
  if (!robots.done) {
    if (!step.canStart()) return;
    await readFile(step, `${config.origin}/robots.txt`, config.pageHosts, robots, 500_000, (res) => {
      robots.text = res.status === 200 ? (res.body ?? '') : null;
    });
    if (!robots.done) return;
  }
  // RFC 9309: a 4xx means no restrictions; an unreadable file means the
  // crawler must assume it may crawl nothing.
  robots.mode ??= robotsModeOf(robots.status);
  if (robots.mode === 'unreadable') {
    step.fail(
      `robots.txt could not be read (${robots.error ?? `HTTP ${robots.status}`}). A crawler must then assume it may not crawl (RFC 9309), so the audit stopped.`,
    );
    return;
  }

  state.index ??= { status: null, error: null, attempts: 0, done: false, children: [], failures: [] };
  const index = state.index;
  if (!index.done) {
    if (!step.allows(new URL(`${config.origin}/sitemap.xml`))) {
      index.done = true;
      index.error = ROBOTS_SKIP;
    } else {
      if (!step.canStart()) return;
      await readFile(step, `${config.origin}/sitemap.xml`, config.pageHosts, index, 5_000_000, (res) => {
        if (res.status === 200 && res.body !== null) {
          index.failures = checkSitemapIndex(res.body, PRODUCTION_ORIGIN);
          index.children = unique(sitemapLocs(res.body).map((loc) => sitePath(loc, config.linkHosts)).filter((p): p is string => p !== null));
        } else {
          index.failures = [`/sitemap.xml answers HTTP ${res.status}`];
        }
      });
      if (!index.done) return;
    }
  }

  state.children ??= Object.fromEntries(index.children.map((p) => [p, { status: null, error: null, attempts: 0, done: false, failures: [] }]));
  const children = state.children;
  const todo = Object.entries(children).filter(([, c]) => !c.done);
  await pool(todo, config.concurrency, () => step.canStart(), async ([path, child]) => {
    if (!step.allows(new URL(`${config.origin}${path}`))) {
      child.done = true;
      child.error = ROBOTS_SKIP;
      return;
    }
    await readFile(step, `${config.origin}${path}`, config.pageHosts, child, 5_000_000, (res) => {
      if (res.status === 200 && res.body !== null) {
        child.xml = res.body;
        child.failures = checkUrlset(res.body, PRODUCTION_ORIGIN);
      } else {
        child.failures = [`HTTP ${res.status}`];
      }
    });
  });
  if (Object.values(children).some((c) => !c.done)) return;

  await seed(step);
}

/** Assemble the site-file checks and queue the URLs to check, best first, up to the budget. */
async function seed(step: Step): Promise<void> {
  const { config, state, run } = step;
  const index = state.index!;
  const children = state.children!;
  const read = Object.entries(children).filter(([, c]) => c.status === 200 && c.xml !== undefined);
  const allRead = index.status === 200 && read.length === Object.keys(children).length;
  const today = iso(step.deps.now()).slice(0, 10);

  state.site = {
    robots: config.production
      ? {
          checked: state.robots?.status != null,
          failures:
            state.robots?.status === 200
              ? checkRobotsTxt(state.robots.text ?? '', PRODUCTION_ORIGIN)
              : state.robots?.status != null
                ? [`robots.txt answers HTTP ${state.robots.status}`]
                : [],
        }
      : null,
    sitemapIndex: { checked: index.status !== null, failures: index.failures },
    children: Object.entries(children).map(([path, c]) => ({ path, checked: c.status !== null, failures: c.failures })),
    hygiene: { checked: allRead, failures: checkSitemapHygiene(read.map(([path, c]) => ({ path, xml: c.xml as string })), today) },
  };
  state.sitemapsComplete = allRead;

  interface Candidate {
    path: string;
    sources: Set<string>;
    inSitemap: boolean;
    loc: string | null;
    expectedLive: boolean;
    expectIndex: boolean | null;
    expectFollow: boolean | null;
    priority: number;
  }
  const merged = new Map<string, Candidate>();
  const add = (path: string, c: Partial<Candidate> & { source: string }) => {
    const prev = merged.get(path) ?? {
      path, sources: new Set<string>(), inSitemap: false, loc: null, expectedLive: false, expectIndex: null, expectFollow: null, priority: 9,
    };
    prev.sources.add(c.source);
    prev.inSitemap ||= c.inSitemap ?? false;
    prev.loc ??= c.loc ?? null;
    prev.expectedLive ||= c.expectedLive ?? false;
    prev.expectIndex ??= c.expectIndex ?? null;
    prev.expectFollow ??= c.expectFollow ?? null;
    prev.priority = Math.min(prev.priority, c.priority ?? 9);
    merged.set(path, prev);
  };

  for (const s of (await step.ctx()).seeds) {
    add(s.path, { source: s.source, expectedLive: s.live, expectIndex: s.expectIndex, expectFollow: s.expectFollow, priority: s.priority });
  }
  for (const [child, c] of read) {
    for (const loc of sitemapLocs(c.xml as string)) {
      const path = sitePath(loc, config.linkHosts);
      if (path) add(path, { source: `sitemap:${child}`, inSitemap: true, loc, expectedLive: true, priority: 2 });
    }
  }

  // The crawl only treats clean URLs and ?page=N archives as pages (sitecrawl → crawlable).
  const list = [...merged.values()].filter((c) => crawlable(c.path)).sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));
  const rows = list.map((c, i) => ({
    run_id: run.id,
    kind: 'page',
    path: c.path,
    state: i < run.maxPages ? 'pending' : 'skipped',
    skip_reason: i < run.maxPages ? null : BUDGET_SKIP,
    priority: c.priority,
    sources: [...c.sources].sort(),
    in_sitemap: c.inSitemap,
    // The column holds 2048 characters; a longer <loc> would fail the whole insert, every step.
    loc: c.loc && c.loc.length <= MAX_URL_LENGTH ? c.loc : null,
    expected_live: c.expectedLive,
    expect_index: c.expectIndex,
    expect_follow: c.expectFollow,
  }));
  await inChunks(rows, 500, (chunk) => siteAuditPageRepo.insertManyRaw(chunk, { ignoreDuplicatesOn: 'run_id,kind,path' }));

  for (const c of Object.values(children)) delete c.xml;
  step.known = new Known();
  for (const r of rows) step.known.set('page', r.path, { kind: 'page', state: r.state as KnownRow['state'], skipReason: r.skip_reason });
  step.phase = 'crawl';
}

/* ── Fetching one URL ─────────────────────────────────────────────────────── */

/** The columns a fetch writes. Every result carries all of them, so a batch can be upserted as one request. */
type Result = Record<
  | 'state' | 'attempts' | 'status' | 'final_status' | 'final_url' | 'hops' | 'loop' | 'offsite' | 'error' | 'skip_reason'
  | 'record' | 'links' | 'images' | 'ms' | 'fetched_at',
  unknown
>;

interface Outcome {
  row: ISiteAuditPage;
  result: Result;
  read?: ReadPage;
}

const blankResult = (): Result => ({
  state: 'done', attempts: 0, status: null, final_status: null, final_url: null, hops: [], loop: false, offsite: null,
  error: null, skip_reason: null, record: null, links: null, images: null, ms: null, fetched_at: null,
});

async function fetchRow(step: Step, row: ISiteAuditPage, opts: { read: boolean; hosts: readonly string[]; head?: boolean }): Promise<Outcome> {
  const result = blankResult();
  result.attempts = (row.attempts ?? 0) + 1;
  const startUrl = row.kind === 'image' ? row.path : `${step.config.origin}${row.path}`;

  let start: URL;
  try {
    start = new URL(startUrl);
  } catch {
    return { row, result: { ...result, state: 'failed', error: 'not a valid URL' } };
  }
  if (!step.allows(start)) {
    const unreadable = step.policyFor(start.hostname) === null;
    const reason = unreadable ? `robots.txt for ${start.hostname} could not be read`.slice(0, 300) : ROBOTS_SKIP;
    return { row, result: { ...result, attempts: row.attempts ?? 0, state: 'skipped', skip_reason: reason } };
  }

  const box: { first?: FetchResult; stoppedAt?: string } = {};
  const began = step.deps.now();
  try {
    const followed = await followRedirects(start.href, async (u) => {
      if (box.first) {
        const check = checkAuditUrl(u, opts.hosts);
        if (!check.ok) {
          box.stoppedAt = `${new URL(u).host} (${check.reason})`;
          return { status: 0, location: null };
        }
        if (!step.allows(check.url)) {
          box.stoppedAt = `${check.url.pathname} (${ROBOTS_SKIP})`;
          return { status: 0, location: null };
        }
      }
      let res = await step.request(u, opts.hosts, { method: opts.head ? 'HEAD' : 'GET', readBody: opts.read && !box.first });
      // Some servers refuse HEAD; ask again without reading the body.
      if (opts.head && (res.status === 405 || res.status === 501)) res = await step.request(u, opts.hosts, { method: 'GET', readBody: false });
      box.first ??= res;
      return { status: res.status, location: res.location };
    });

    const first = box.first as FetchResult;
    const hops: Hop[] = followed.hops.map((h) => ({ status: h.status, location: h.location }));
    result.status = first.status;
    result.final_status = box.stoppedAt ? (hops.at(-1)?.status ?? null) : followed.final.status || null;
    result.final_url = followed.final.url.slice(0, MAX_URL_LENGTH);
    result.hops = hops;
    result.loop = followed.loop && !box.stoppedAt;
    result.offsite = box.stoppedAt?.slice(0, 300) ?? null;
    result.ms = step.deps.now() - began;
    result.fetched_at = iso(step.deps.now());

    if (opts.read && first.status === 200 && hops.length === 0 && first.body !== null && isHtml(first.contentType)) {
      const read = readPage({
        path: row.path,
        url: start.href,
        html: first.body,
        contentType: first.contentType,
        truncated: first.truncated,
        xRobotsTag: first.xRobotsTag,
        hostNoindex: step.config.hostNoindex,
        linkHosts: step.config.linkHosts,
        // A <loc> too long to store is judged as the page's own canonical URL, as the analysis does.
        sitemapLoc: row.inSitemap ? (row.loc ?? canonicalUrlFor(PRODUCTION_ORIGIN, row.path)) : null,
        status: first.status,
      });
      result.record = read.record;
      result.links = read.links;
      result.images = read.images;
      return { row, result, read };
    }
    return { row, result };
  } catch (err) {
    if (!(err instanceof FetchFailure)) throw err;
    const exhausted = !err.transient || (result.attempts as number) >= step.config.attempts;
    return { row, result: { ...result, state: exhausted ? 'failed' : 'pending', error: err.reason.slice(0, 300) } };
  }
}

async function writeOutcomes(step: Step, outcomes: readonly Outcome[]): Promise<void> {
  const rows = outcomes.map(({ row, result }) => ({ id: row.id, run_id: row.runId, kind: row.kind, path: row.path, ...result }));
  await inChunks(rows, 100, (chunk) => siteAuditPageRepo.upsertManyRaw(chunk, 'id'));
  const known = await step.knownRows();
  for (const { row, result } of outcomes) {
    known.set(row.kind, row.path, { kind: row.kind, state: result.state as KnownRow['state'], skipReason: (result.skip_reason as string | null) ?? null });
  }
}

/** Queue what a page links to and the images it shows, within the budget. */
function discoverFrom(step: Step, from: ReadPage, known: Known, budget: Record<'page' | 'link' | 'image', number>, fresh: Record<string, unknown>[]) {
  const runId = step.run.id;
  const queue = (kind: 'page' | 'link' | 'image', path: string, overBudget: boolean) => {
    fresh.push({
      run_id: runId,
      kind,
      path,
      state: overBudget ? 'skipped' : 'pending',
      skip_reason: overBudget ? BUDGET_SKIP : null,
      priority: 4,
      sources: [kind === 'image' ? 'image' : 'link'],
      in_sitemap: false,
      loc: null,
      expected_live: false,
      expect_index: null,
      expect_follow: null,
    });
    known.set(kind, path, { kind, state: overBudget ? 'skipped' : 'pending', skipReason: overBudget ? BUDGET_SKIP : null });
  };

  for (const link of from.links) {
    const to = link.to;
    if (to.length > MAX_URL_LENGTH || known.has('page', to) || known.has('link', to)) continue;
    // sitecrawl: clean URLs and ?page=N archives are crawled as pages; brochure PDFs never are.
    const asPage = crawlable(to) && !/^\/brochures\/.+\.pdf$/.test(to);
    if (asPage && budget.page > 0) {
      budget.page--;
      queue('page', to, false);
    } else if (budget.link > 0) {
      budget.link--;
      queue('link', to, false);
    } else {
      queue(asPage ? 'page' : 'link', to, true);
    }
  }

  for (const src of from.images) {
    if (src.length > MAX_URL_LENGTH || known.has('image', src)) continue;
    const host = new URL(src).hostname.toLowerCase();
    if (!step.config.mediaHosts.includes(host)) {
      const hosts = (step.state.externalImageHosts ??= []);
      if (!hosts.includes(host) && hosts.length < 20) hosts.push(host);
      continue;
    }
    if (budget.image > 0) {
      budget.image--;
      queue('image', src, false);
    } else {
      queue('image', src, true);
    }
  }
}

/* ── crawl, links, images ─────────────────────────────────────────────────── */

const pendingOf = (runId: string, kind: 'page' | 'link' | 'image', limit: number) =>
  siteAuditPageRepo.findMany({
    filter: { runId, kind, state: 'pending' },
    sort: [{ field: 'priority', direction: 1 }, { field: 'createdAt', direction: 1 }],
    limit,
    fields: ['runId', 'kind', 'path', 'state', 'attempts', 'inSitemap', 'loc', 'createdAt'],
  });

async function crawl(step: Step): Promise<void> {
  const pending = await pendingOf(step.run.id, 'page', PAGE_BATCH);
  if (pending.length === 0) {
    step.phase = 'links';
    return;
  }
  const known = await step.knownRows();
  const budget = {
    page: step.run.maxPages - known.used('page'),
    link: step.run.maxPages - known.used('link'),
    image: step.run.maxPages - known.used('image'),
  };
  const outcomes: Outcome[] = [];
  const fresh: Record<string, unknown>[] = [];
  await pool(pending, step.config.concurrency, () => step.canStart(), async (row) => {
    const outcome = await fetchRow(step, row, { read: true, hosts: step.config.pageHosts });
    outcomes.push(outcome);
    if (outcome.read) discoverFrom(step, outcome.read, known, budget, fresh);
  });
  await writeOutcomes(step, outcomes);
  await inChunks(fresh, 500, (chunk) => siteAuditPageRepo.insertManyRaw(chunk, { ignoreDuplicatesOn: 'run_id,kind,path' }));
}

async function checkLinks(step: Step): Promise<void> {
  const pending = await pendingOf(step.run.id, 'link', STATUS_BATCH);
  if (pending.length === 0) {
    step.phase = 'images';
    return;
  }
  const outcomes: Outcome[] = [];
  await pool(pending, step.config.concurrency, () => step.canStart(), async (row) => {
    outcomes.push(await fetchRow(step, row, { read: false, hosts: step.config.pageHosts }));
  });
  await writeOutcomes(step, outcomes);
}

async function checkImages(step: Step): Promise<void> {
  const pending = await pendingOf(step.run.id, 'image', STATUS_BATCH);
  if (pending.length === 0) {
    step.phase = 'analyze';
    return;
  }
  // robots.txt of each media host first (the site's own host is already known).
  const hosts = unique(pending.map((r) => new URL(r.path).hostname.toLowerCase())).filter((h) => !step.config.pageHosts.includes(h));
  for (const host of hosts) {
    const all = (step.state.hostRobots ??= {});
    const entry = (all[host] ??= { status: null, error: null, attempts: 0, done: false, text: null });
    if (entry.done) continue;
    if (!step.canStart()) return;
    await readFile(step, `https://${host}/robots.txt`, step.config.mediaHosts, entry, 500_000, (res) => {
      entry.text = res.status === 200 ? (res.body ?? '') : null;
    });
    if (entry.done) entry.mode = robotsModeOf(entry.status);
    else return;
  }
  const outcomes: Outcome[] = [];
  await pool(pending, step.config.concurrency, () => step.canStart(), async (row) => {
    outcomes.push(await fetchRow(step, row, { read: false, hosts: step.config.mediaHosts, head: true }));
  });
  await writeOutcomes(step, outcomes);
}

/* ── analyze ──────────────────────────────────────────────────────────────── */

export function coverageOf(known: Known, state: RunState): RunCoverage {
  const p = known.progress();
  const graph = (['page', 'link'] as const).every((k) => p[k].pending === 0 && p[k].failed === 0 && p[k].skipped === 0);
  const children = Object.values(state.children ?? {});
  const sitemaps: RunCoverage['sitemaps'] = !state.index?.done
    ? 'pending'
    : state.sitemapsComplete
      ? 'complete'
      : state.index.status === 200 && children.some((c) => c.status === 200)
        ? 'partial'
        : 'unavailable';
  return {
    complete: graph && sitemaps === 'complete',
    imagesComplete: p.image.pending === 0 && p.image.failed === 0 && p.image.skipped === 0,
    sitemaps,
    budgetSkipped: known.skips(BUDGET_SKIP),
    robotsSkipped: p.page.skipped + p.link.skipped + p.image.skipped - known.skips(BUDGET_SKIP),
    failed: p.page.failed + p.link.failed + p.image.failed,
    externalImageHosts: state.externalImageHosts ?? [],
  };
}

function toAuditRow(r: ISiteAuditPage): AuditRow {
  return {
    kind: r.kind,
    path: r.path,
    state: r.state,
    sources: r.sources ?? [],
    inSitemap: r.inSitemap ?? false,
    loc: r.loc ?? null,
    expectedLive: r.expectedLive ?? false,
    expectIndex: r.expectIndex ?? null,
    expectFollow: r.expectFollow ?? null,
    status: r.status ?? null,
    finalStatus: r.finalStatus ?? null,
    finalUrl: r.finalUrl ?? null,
    hops: r.hops ?? [],
    loop: r.loop ?? false,
    offsite: r.offsite ?? null,
    error: r.error ?? null,
    skipReason: r.skipReason ?? null,
    record: (r.record as PageRecord | undefined) ?? null,
    links: (r.links as StoredLink[] | undefined) ?? null,
    images: r.images ?? null,
  };
}

const ISSUE_STATE_FIELDS = ['fingerprint', 'rule', 'path', 'status', 'timesSeen', 'reopenedCount', 'firstRunId', 'lastRunId', 'resolvedRunId', 'firstSeenAt'];

async function analyzeRun(step: Step): Promise<void> {
  const { run, config, state } = step;
  const rows = (await readAll(siteAuditPageRepo, { runId: run.id }, undefined, ANALYZE_PAGE_SIZE)).map(toAuditRow);
  const known = new Known();
  for (const r of rows) known.set(r.kind, r.path, { kind: r.kind, state: r.state, skipReason: r.skipReason });
  step.known = known;
  const coverage = coverageOf(known, state);
  const site: SiteChecks = state.site ?? { robots: null, sitemapIndex: { checked: false, failures: [] }, children: [], hygiene: { checked: false, failures: [] } };
  const context = await step.ctx();

  const findings = analyze({
    rows,
    site,
    coverageComplete: coverage.complete,
    sitemapsComplete: state.sitemapsComplete ?? false,
    hostNoindex: config.hostNoindex,
    textSources: context.textSources,
  });
  const keyed: KeyedFinding[] = findings.map((f) => ({
    ...f,
    fingerprint: fingerprint(config.origin, f.rule, f.path, f.target),
    adminPath: context.adminPathFor(f.path) ?? (f.affected[0] ? context.adminPathFor(f.affected[0]) : null),
  }));

  const toStored = (i: { id: string; fingerprint: string; rule: string; path: string; status: 'open' | 'resolved'; timesSeen: number; reopenedCount: number; firstRunId?: string | null; lastRunId?: string | null; resolvedRunId?: string | null; firstSeenAt: string }): StoredIssue => ({
    id: i.id,
    fingerprint: i.fingerprint,
    rule: i.rule,
    path: i.path,
    status: i.status,
    timesSeen: i.timesSeen,
    reopenedCount: i.reopenedCount,
    firstRunId: i.firstRunId ?? null,
    lastRunId: i.lastRunId ?? null,
    resolvedRunId: i.resolvedRunId ?? null,
    firstSeenAt: i.firstSeenAt,
  });
  const existing = new Map<string, StoredIssue>();
  for (const i of await readAll(siteAuditIssueRepo, { origin: config.origin, status: 'open' }, ISSUE_STATE_FIELDS)) existing.set(i.id, toStored(i));
  await inChunks(unique(keyed.map((k) => k.fingerprint)), 100, async (chunk) => {
    const found = await siteAuditIssueRepo.findMany({ filter: { fingerprint: { op: 'in', value: chunk } }, fields: ISSUE_STATE_FIELDS });
    for (const i of found) existing.set(i.id, toStored(i));
  });

  const at = iso(step.deps.now());
  const evaluation = evaluationOf(rows, site, { complete: coverage.complete, imagesComplete: coverage.imagesComplete, sitemapsComplete: state.sitemapsComplete ?? false });
  const plan = planLifecycle([...existing.values()], keyed, { id: run.id, at, origin: config.origin }, (rule, path) => isEvaluated(evaluation, rule, path));

  // Still ours? Then write the history.
  await step.save({});
  await inChunks(plan.upserts, 200, (chunk) => siteAuditIssueRepo.upsertManyRaw(chunk, 'fingerprint'));
  await inChunks(plan.resolve, 100, (chunk) =>
    siteAuditIssueRepo.updateWhereRaw({ id: { op: 'in', value: chunk }, status: 'open' }, { status: 'resolved', resolved_at: at, resolved_run_id: run.id }, { fields: [] }),
  );

  const reported = new Map(keyed.map((k) => [k.fingerprint, k]));
  const found = [...reported.values()];
  const count = (pred: (f: KeyedFinding) => boolean) => found.filter(pred).length;
  step.summary = {
    found: { total: found.length, fix: count((f) => f.severity === 'fix'), review: count((f) => f.severity === 'review'), info: count((f) => f.severity === 'info') },
    byCategory: Object.fromEntries(unique(found.map((f) => f.category)).map((c) => [c, count((f) => f.category === c)])),
    ...plan.counts,
    pagesRead: rows.filter((r) => r.kind === 'page' && r.record).length,
    analysedAt: at,
  };
  step.phase = 'done';
  step.status = 'completed';
  step.finishedAt = at;

  // Older runs' bulky readings are no longer needed: only the latest run can be retried.
  const older = await siteAuditRunRepo.findMany({
    filter: { scratchCleared: false, id: { op: 'neq', value: run.id }, status: { op: 'in', value: ['completed', 'failed', 'cancelled'] } },
    fields: [],
    limit: 10,
  });
  for (const o of older) {
    await siteAuditPageRepo.updateWhereRaw({ runId: o.id }, { record: null, links: null, images: null }, { fields: [] });
    await siteAuditRunRepo.updateWhereRaw({ id: o.id }, { scratch_cleared: true }, { fields: [] });
  }
}

/* ── Entry points ─────────────────────────────────────────────────────────── */

export type StepResult =
  | { outcome: 'advanced' | 'finished'; run: ISiteAuditRun }
  /** Another step holds the lease; try again shortly. */
  | { outcome: 'busy'; run: ISiteAuditRun }
  /** Completed, failed or cancelled: nothing to advance. */
  | { outcome: 'inactive'; run: ISiteAuditRun }
  | { outcome: 'not-found' };

export async function stepRun(runId: string, config: AuditConfig, deps: EngineDeps): Promise<StepResult> {
  const started = deps.now();
  const token = randomUUID();
  const [claimed] = await siteAuditRunRepo.updateWhereRaw(
    { id: runId, status: { op: 'in', value: ['queued', 'running'] }, leaseUntil: { op: 'lt', value: iso(started) } },
    { lease_until: iso(started + config.stepMs + LEASE_GRACE_MS), lease_token: token, status: 'running' },
    { fields: RUN_WORK_FIELDS },
  );
  if (!claimed) {
    const run = await siteAuditRunRepo.findById(runId, { fields: RUN_VIEW_FIELDS });
    if (!run) return { outcome: 'not-found' };
    return { outcome: run.status === 'queued' || run.status === 'running' ? 'busy' : 'inactive', run };
  }

  const step = new Step(claimed, token, config, deps, started);
  try {
    if (claimed.origin !== config.origin) {
      step.fail(`SEO_AUDIT_ORIGIN changed to ${config.origin} after this run started on ${claimed.origin}. Start a new run.`);
    } else if (step.phase === 'discover') await discover(step);
    else if (step.phase === 'crawl') await crawl(step);
    else if (step.phase === 'links') await checkLinks(step);
    else if (step.phase === 'images') await checkImages(step);
    else if (step.phase === 'analyze') await analyzeRun(step);

    const known = step.known ?? (step.phase === 'discover' ? new Known() : await Known.load(claimed.id));
    const run = await step.save({
      phase: step.phase,
      status: step.status,
      state: step.state,
      progress: known.progress(),
      coverage: coverageOf(known, step.state),
      error: step.error,
      steps: (claimed.steps ?? 0) + 1,
      ...(step.summary ? { summary: step.summary } : {}),
      ...(claimed.startedAt ? {} : { started_at: iso(started) }),
      ...(step.finishedAt ? { finished_at: step.finishedAt } : {}),
      // Released: the next step may start at once.
      lease_until: EPOCH,
      lease_token: null,
    });
    return { outcome: run.status === 'running' ? 'advanced' : 'finished', run };
  } catch (err) {
    if (err instanceof LeaseLost) {
      const run = await siteAuditRunRepo.findById(runId, { fields: RUN_VIEW_FIELDS });
      return run ? { outcome: run.status === 'running' ? 'busy' : 'inactive', run } : { outcome: 'not-found' };
    }
    // Leave the run as it was for the next step to retry; free the lease now.
    await siteAuditRunRepo
      .updateWhereRaw({ id: runId, leaseToken: token }, { lease_until: EPOCH, lease_token: null }, { fields: [] })
      .catch(() => undefined);
    throw err;
  }
}

export type StartResult =
  | { outcome: 'started'; run: ISiteAuditRun }
  | { outcome: 'active'; run: ISiteAuditRun }
  | { outcome: 'cooldown'; run: ISiteAuditRun; nextAllowedAt: string };

/** The run in progress, if any (there is at most one). */
export async function activeRun(): Promise<ISiteAuditRun | null> {
  return siteAuditRunRepo.findOne({ status: { op: 'in', value: ['queued', 'running'] } }, { fields: [...RUN_VIEW_FIELDS, 'starter'], sort: [{ field: 'createdAt', direction: -1 }, { field: 'id', direction: -1 }] });
}

export async function latestRun(origin: string, statuses?: SiteAuditRunStatus[]): Promise<ISiteAuditRun | null> {
  return siteAuditRunRepo.findOne(
    { origin, ...(statuses ? { status: { op: 'in', value: statuses } } : {}) },
    { fields: [...RUN_VIEW_FIELDS, 'starter'], sort: [{ field: 'createdAt', direction: -1 }, { field: 'id', direction: -1 }] },
  );
}

export async function startRun(config: AuditConfig, userId: string | null, now: number): Promise<StartResult> {
  const active = await activeRun();
  if (active) return { outcome: 'active', run: active };
  const last = await latestRun(config.origin, ['completed']);
  if (last?.finishedAt) {
    const next = new Date(last.finishedAt).getTime() + config.cooldownMs;
    if (next > now) return { outcome: 'cooldown', run: last, nextAllowedAt: iso(next) };
  }
  const run = await siteAuditRunRepo.insertRaw(
    { origin: config.origin, status: 'queued', phase: 'discover', max_pages: config.maxPages, started_by: userId, lease_until: EPOCH },
    { fields: RUN_VIEW_FIELDS },
  );
  return { outcome: 'started', run };
}

/**
 * Stop a run in progress. Its findings so far are not analysed, so no issue
 * changes. A run already analysing is not stopped: that last step writes the
 * issue history, and stopping it half-way would leave history no run owns.
 */
export async function cancelRun(runId: string, now: number): Promise<ISiteAuditRun | null> {
  const [run] = await siteAuditRunRepo.updateWhereRaw(
    { id: runId, status: { op: 'in', value: ['queued', 'running'] }, phase: { op: 'neq', value: 'analyze' } },
    { status: 'cancelled', finished_at: iso(now), lease_until: EPOCH, lease_token: null },
    { fields: RUN_VIEW_FIELDS },
  );
  return run ?? null;
}

export type RetryResult =
  | { outcome: 'retrying'; run: ISiteAuditRun; requeued: number }
  | { outcome: 'not-latest' | 'nothing-to-retry' | 'not-finished' | 'active-elsewhere' };

/**
 * Check again what failed in the latest run: URLs that never answered go
 * back in the queue, and the run is analysed again when they are done
 * (lifecycle.ts makes a second analysis of the same run safe). A run that
 * failed before it found any URLs starts its discovery again.
 */
export async function retryRun(runId: string, config: AuditConfig): Promise<RetryResult> {
  const run = await siteAuditRunRepo.findById(runId, { fields: RUN_WORK_FIELDS });
  if (!run) return { outcome: 'not-latest' };
  const latest = await latestRun(run.origin);
  if (!latest || latest.id !== run.id || run.origin !== config.origin) return { outcome: 'not-latest' };
  if (run.status !== 'completed' && run.status !== 'failed') return { outcome: 'not-finished' };
  if (await activeRun()) return { outcome: 'active-elsewhere' };

  const requeued = await siteAuditPageRepo.updateWhereRaw({ runId: run.id, state: 'failed' }, { state: 'pending', attempts: 0, error: null }, { fields: [] });
  const state = (run.state ?? {}) as RunState;
  const discoveryFailed = run.phase === 'discover';
  if (!discoveryFailed && requeued.length === 0) return { outcome: 'nothing-to-retry' };

  const kinds = new Set(
    (await siteAuditPageRepo.findMany({ filter: { runId: run.id, state: 'pending' }, fields: ['kind'], limit: 1000 })).map((r) => r.kind),
  );
  const phase: SiteAuditPhase = discoveryFailed ? 'discover' : kinds.has('page') ? 'crawl' : kinds.has('link') ? 'links' : kinds.has('image') ? 'images' : 'analyze';
  const [updated] = await siteAuditRunRepo.updateWhereRaw(
    { id: run.id, status: run.status },
    {
      status: 'running',
      phase,
      error: null,
      finished_at: null,
      lease_until: EPOCH,
      lease_token: null,
      // Discovery starts over; otherwise the state (robots.txt, sitemap checks) still holds.
      state: discoveryFailed ? {} : state,
    },
    { fields: RUN_VIEW_FIELDS },
  );
  if (!updated) return { outcome: 'not-finished' };
  return { outcome: 'retrying', run: updated, requeued: requeued.length };
}

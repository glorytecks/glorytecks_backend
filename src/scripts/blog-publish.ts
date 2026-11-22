/**
 * Validates rewritten blog articles and writes them to Supabase, one article at
 * a time, keyed by the article id (Phase 11, docs/BLOG_REWRITE_FINAL_REPORT.md).
 * The only script in this programme that writes blog rows.
 *
 *   npx tsx src/scripts/blog-publish.ts run <rewriteDir> --backup <backupDir> --by <who> [--confirm]
 *       [--only <slug>] [--limit <n>] [--retry-failed] [--ledger <path>] [--no-linkcheck]
 *   npx tsx src/scripts/blog-publish.ts purge-cache
 *       Clears the API's cached blog responses (Redis public:blogs:*) without writing anything.
 *
 * Without --confirm it validates and records results, and writes nothing.
 *
 * Per article:
 *   1. Re-reads the live row by id (exactly one row, or the batch stops).
 *   2. Checks every cited source URL and records the HTTP status in the file.
 *   3. Runs the gate (lib/blogGate.ts): quality and metadata. A failure moves the
 *      article to needs_review with the reasons; the batch continues.
 *   4. Writes the full current row to backups/blog-rewrites/<run>/<slug>.before.json.
 *   5. Marks the article `processing` in the ledger, then updates the row through
 *      BlogService.updateBlog (the admin panel's path, so html/toc/faqs/read time
 *      are derived as usual): UPDATE … WHERE id = <id>, retried on transient errors.
 *   6. Reads the row back and checks id, slug, category, publication date, status,
 *      title, byline, content checksum, excerpt, SEO and OG fields and `updated`.
 *      Any mismatch rolls the row back from the snapshot, marks it failed and stops.
 *   7. Marks it `supabase_updated`.
 *
 * Fail-safe: authentication or schema errors, a missing or duplicated row, a
 * write that errors after retries, or a failed read-back stop the whole run.
 * A lock file prevents two runs at once. An article left `processing` by a
 * crash is settled from the live row before anything else happens.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { supabaseAdmin } from '../config/supabase';
import { blogRepo } from '../repositories';
import { blogService } from '../services/blog.service';
import { invalidateResource } from '../lib/cacheInvalidation';
import { connectRedis, disconnectRedis, isRedisReady } from '../config/redis';
import { validateBlocks } from '../validators/blocks.validator';
import { blocksToHtml, type Block } from '../utils/blocks';
import type { IBlog } from '../interfaces/common';
import { buildUpdate, contentSha256, rewriteFileProblem, rollbackUpdate, snapshotOf, type LiveRow, type RewriteFile } from './lib/blogRewrite';
import { blockTexts, gateArticle, type GateFile, type GateLiveRow } from './lib/blogGate';
import { inFlight, ledgerProblem, transition, type Ledger, type LedgerEntry, type ProcessingStatus } from './lib/blogStatus';

type UpdatePayload = Parameters<typeof blogService.updateBlog>[1];
type Row = Record<string, unknown>;

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
const [command, target] = argv;
const confirm = has('confirm');
const by = flag('by') ?? '';
const only = flag('only');
const limit = Number(flag('limit') ?? Infinity);
const ledgerPath = path.resolve(flag('ledger') ?? path.join('content', 'blog-rewrites', 'ledger.json'));
const lockPath = path.join(path.dirname(ledgerPath), '.publish.lock');

/** The organization bylines (docs/BLOG_AUTHOR_POLICY.md). */
export const ORGANIZATION_AUTHOR_KEYS = ['glorytecks-team', 'glorytecks-editorial-team'];

/** Every column the gate and the read-back use. A missing one means the schema changed: stop. */
const COLUMNS =
  'id,slug,title,category_slug,date,updated,status,author_key,excerpt,content,seo_meta_title,seo_meta_description,seo_og_title,seo_og_description,seo_og_image,seo_canonical_url,seo_noindex,updated_at';

class StopRun extends Error {}

const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

function wordsOf(blocks: unknown): number {
  const texts = Array.isArray(blocks) ? blockTexts(blocks as Block[]) : [];
  return texts
    .join(' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

async function readRow(id: string): Promise<Row> {
  const { data, error } = await supabaseAdmin.from('blogs').select(COLUMNS).eq('id', id);
  if (error) throw new StopRun(`read ${id}: ${error.message}`);
  if (!data || data.length !== 1) throw new StopRun(`read ${id}: expected exactly one row, got ${data?.length ?? 0}`);
  return data[0] as unknown as Row;
}

async function apiRow(id: string): Promise<LiveRow> {
  const doc = (await blogRepo.findById(id, { detail: true })) as (IBlog & { id?: string }) | null;
  if (!doc) throw new StopRun(`${id}: not found through the repository`);
  return { id: String(doc.id), slug: doc.slug, title: doc.title, authorKey: doc.authorKey, content: doc.content, excerpt: doc.excerpt, updated: doc.updated, readTime: doc.readTime, seo: doc.seo ?? null };
}

async function checkUrl(url: string): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'Mozilla/5.0 (GloryTecks editorial link check)' } });
      return res.status;
    } catch {
      /* retry once */
    }
  }
  return 0;
}

const TRANSIENT = /fetch failed|ECONNRESET|ETIMEDOUT|socket|network|timeout|503|502|504|429|rate/i;

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!TRANSIENT.test(String((err as Error)?.message ?? err))) break;
      await new Promise((r) => setTimeout(r, attempt * 3000));
      console.log(`          retrying ${label} (attempt ${attempt + 1})`);
    }
  }
  throw last;
}

function readMergedSlugs(): Set<string> {
  const file = path.resolve('..', 'main-website', 'lib', 'blog', 'merged.ts');
  if (!existsSync(file)) return new Set();
  return new Set([...readFileSync(file, 'utf8').matchAll(/from:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]));
}

function readStaticPaths(): Set<string> {
  const file = path.resolve('..', 'main-website', 'docs', 'SEO_URL_INVENTORY.csv');
  const paths = new Set(['/', '/blog', '/courses', '/compare', '/training-in-hyderabad', '/about', '/contact', '/placements', '/resources']);
  if (!existsSync(file)) return paths;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
    const url = line.split(',')[0];
    if (!url) continue;
    const p = url.replace(/^https?:\/\/[^/]+/, '') || '/';
    if (!p.startsWith('/blog/')) paths.add(p);
  }
  return paths;
}

/**
 * Clear the API's cached blog responses so the site reads the new rows. This
 * process has its own Redis connection: the server's cache is only reachable
 * through Redis, so without connecting first the purge would silently do nothing.
 */
async function purgeApiCache(): Promise<boolean> {
  await connectRedis();
  if (!isRedisReady()) {
    console.log('API cache NOT purged (Redis unavailable): cached blog responses expire on their own within 10 minutes (CACHE_TTL.BLOGS).');
    return false;
  }
  await invalidateResource('blogs');
  await disconnectRedis();
  console.log('API cache purged (public:blogs:*).');
  return true;
}

function move(ledger: Ledger, entry: LedgerEntry, to: ProcessingStatus, note: string, batch?: string) {
  if (entry.status === to) return;
  const err = transition(ledger, entry.id, { to, by: by || 'blog-publish', note, at: new Date().toISOString(), batch });
  if (err) throw new StopRun(`ledger: ${err}`);
}

async function run(dir: string) {
  if (!by.trim()) fail('Say who is running this: --by <name>');
  const backupDir = flag('backup') ?? fail('run needs --backup <dir> (the verified baseline)');
  const manifest = JSON.parse(readFileSync(path.join(backupDir, 'manifest.json'), 'utf8')) as { rows: { id: string; contentSha256: string }[] };
  const originals = new Map((JSON.parse(readFileSync(path.join(backupDir, 'blogs.json'), 'utf8')) as Row[]).map((r) => [String(r.id), r]));
  const baseline = new Map(manifest.rows.map((r) => [r.id, r.contentSha256]));

  let lock: number;
  try {
    lock = openSync(lockPath, 'wx');
  } catch {
    fail(`Another run holds ${lockPath}. If no run is active, delete the file and retry.`);
  }
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger;
  const problem = ledgerProblem(ledger);
  if (problem) fail(`Ledger is invalid: ${problem}`);
  const save = () => writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapDir = path.resolve('backups', 'blog-rewrites', stamp);
  const today = new Date().toISOString().slice(0, 10);
  const log: Row[] = [];
  let written = 0;
  let toReview = 0;

  try {
    // Preflight: authentication and schema. Selecting every column we rely on fails loudly if one is missing.
    const probe = await supabaseAdmin.from('blogs').select(COLUMNS).limit(1);
    if (probe.error) throw new StopRun(`preflight: ${probe.error.message}`);

    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => ({ file: path.join(dir, f), doc: JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as RewriteFile & GateFile & Row }));
    const byId = new Map(files.map((f) => [f.doc.id, f]));

    // Settle anything a crashed run left mid-write.
    for (const entry of inFlight(ledger)) {
      const f = byId.get(entry.id);
      const live = await readRow(entry.id);
      const applied = f && contentSha256(live.content) === contentSha256(f.doc.changes.content);
      move(ledger, entry, applied ? 'supabase_updated' : 'failed', applied ? 'Settled after an interrupted run: the row holds the rewrite.' : 'Settled after an interrupted run: the row does not hold the rewrite.');
      if (!applied) entry.error = 'interrupted write';
      save();
    }

    const liveRows = await supabaseAdmin.from('blogs').select('slug,status');
    if (liveRows.error) throw new StopRun(`slug list: ${liveRows.error.message}`);
    const merged = readMergedSlugs();
    const liveSlugs = new Set((liveRows.data as { slug: string; status: string }[]).filter((r) => r.status === 'published' && !merged.has(r.slug)).map((r) => r.slug));
    const staticPaths = readStaticPaths();

    let processed = 0;
    for (const { file, doc } of files) {
      if (only && doc.slug !== only) continue;
      const entry = ledger.articles[doc.id];
      if (!entry) throw new StopRun(`${doc.slug}: not in the ledger`);
      const eligible = entry.status === 'rewritten' || entry.status === 'validated' || (has('retry-failed') && entry.status === 'failed');
      if (!eligible) continue;
      if (processed >= limit) break;
      processed++;

      const shape = rewriteFileProblem(doc);
      if (shape) throw new StopRun(`${doc.slug}: malformed rewrite file (${shape})`);
      const live = await readRow(doc.id);
      if (live.slug !== doc.slug) throw new StopRun(`${doc.slug}: live slug is ${String(live.slug)}; refusing to write`);
      const batch = String(doc.batch ?? doc.pilot ?? path.basename(dir));
      entry.startedAt ??= new Date().toISOString();
      // Keep the count from the first write: a later correction is measured against the original article.
      entry.wordsBefore ??= wordsOf(originals.get(doc.id)?.content ?? live.content);
      entry.wordsAfter = wordsOf(doc.changes.content);

      // Sources: record the live HTTP status of every cited URL in the file itself.
      if (!has('no-linkcheck')) {
        for (const s of doc.sources ?? []) {
          const status = await checkUrl(s.url);
          s.check = { ...(s.check ?? {}), status, at: new Date().toISOString() };
        }
        writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
      }

      const gateLive: GateLiveRow = {
        id: String(live.id),
        slug: String(live.slug),
        title: String(live.title),
        category_slug: String(live.category_slug),
        date: String(live.date),
        author_key: String(live.author_key ?? ''),
        seo_canonical_url: (live.seo_canonical_url as string) ?? null,
        seo_noindex: Boolean(live.seo_noindex),
        contentSha256: contentSha256(live.content),
        metadataChanged: (
          [
            ['title', live.title],
            ['authorKey', live.author_key],
            ['excerpt', live.excerpt],
            ['metaTitle', live.seo_meta_title],
            ['metaDescription', live.seo_meta_description],
            ['ogTitle', live.seo_og_title],
            ['ogDescription', live.seo_og_description],
          ] as const
        ).some(([key, current]) => doc.changes[key] !== undefined && doc.changes[key] !== current),
      };
      const result = gateArticle(doc, gateLive, {
        sha: contentSha256,
        validateBlocks,
        renderHtml: (b) => blocksToHtml(b),
        organizationAuthorKeys: ORGANIZATION_AUTHOR_KEYS,
        liveSlugs,
        staticPaths,
        baselineSha: baseline.get(doc.id) ?? '',
      });
      const at = new Date().toISOString();
      entry.quality = { ok: result.quality.ok, failures: result.quality.failures, checkedAt: at };
      entry.metadata = { ok: result.metadata.ok, failures: result.metadata.failures, checkedAt: at };
      if (!result.quality.ok || !result.metadata.ok) {
        const reasons = [...result.quality.failures, ...result.metadata.failures];
        console.log(`REVIEW  ${doc.slug}\n          ✗ ${reasons.join('\n          ✗ ')}`);
        move(ledger, entry, 'needs_review', reasons.join(' | '), batch);
        toReview++;
        save();
        continue;
      }
      move(ledger, entry, 'validated', 'Quality and metadata gates passed.', batch);
      save();
      if (!confirm) {
        console.log(`VALID   ${doc.slug} (dry run: not written)`);
        continue;
      }

      // Snapshot, then write by id.
      const before = await apiRow(doc.id);
      mkdirSync(snapDir, { recursive: true });
      const snapFile = path.join(snapDir, `${doc.slug}.before.json`);
      writeFileSync(snapFile, `${JSON.stringify({ ...snapshotOf(before, doc, new Date().toISOString()), raw: live }, null, 2)}\n`);
      move(ledger, entry, 'processing', `Writing to Supabase; snapshot ${path.relative(process.cwd(), snapFile)}`);
      save();

      const payload = buildUpdate(doc, before, today) as UpdatePayload;
      try {
        await withRetry(() => blogService.updateBlog(doc.id, payload), doc.slug);
      } catch (err) {
        entry.error = String((err as Error)?.message ?? err);
        entry.supabase = { result: 'failed', at: new Date().toISOString(), verified: false, snapshot: snapFile };
        move(ledger, entry, 'failed', `Write failed: ${entry.error}`);
        save();
        throw new StopRun(`${doc.slug}: write failed (${entry.error})`);
      }

      // Read back and verify: never assume the API call did what it said.
      const after = await readRow(doc.id);
      const expect: [string, unknown, unknown][] = [
        ['id', after.id, live.id],
        ['slug', after.slug, live.slug],
        ['category', after.category_slug, live.category_slug],
        ['publication date', after.date, live.date],
        ['status', after.status, live.status],
        ['title', after.title, doc.changes.title ?? live.title],
        ['byline', after.author_key, doc.changes.authorKey ?? live.author_key],
        ['content', contentSha256(after.content), contentSha256(doc.changes.content)],
        ['excerpt', after.excerpt, doc.changes.excerpt],
        ['SEO title', after.seo_meta_title, doc.changes.metaTitle],
        ['meta description', after.seo_meta_description, doc.changes.metaDescription],
        ['OG title', after.seo_og_title, doc.changes.ogTitle],
        ['OG description', after.seo_og_description, doc.changes.ogDescription],
        ['updated', after.updated, today],
      ];
      const wrong = expect.filter(([, got, want]) => got !== want).map(([k, got, want]) => `${k}: expected ${String(want).slice(0, 60)}, found ${String(got).slice(0, 60)}`);
      if (String(after.updated_at) <= String(live.updated_at)) wrong.push('updated_at did not advance');
      if (wrong.length) {
        await blogService.updateBlog(doc.id, rollbackUpdate(snapshotOf(before, doc, '')) as UpdatePayload);
        entry.error = `read-back mismatch, rolled back: ${wrong.join('; ')}`;
        entry.supabase = { result: 'rolled_back', at: new Date().toISOString(), verified: false, snapshot: snapFile };
        move(ledger, entry, 'failed', entry.error);
        save();
        throw new StopRun(`${doc.slug}: ${entry.error}`);
      }

      entry.completedAt = new Date().toISOString();
      entry.error = undefined;
      entry.supabase = { result: 'updated', at: entry.completedAt, verified: true, updatedAt: String(after.updated_at), snapshot: path.relative(process.cwd(), snapFile) };
      move(ledger, entry, 'supabase_updated', `Written and verified by id (updated_at ${String(after.updated_at)}).`);
      save();
      written++;
      log.push({ id: doc.id, slug: doc.slug, updatedAt: after.updated_at, snapshot: snapFile });
      writeFileSync(path.join(snapDir, 'publish-log.json'), `${JSON.stringify(log, null, 2)}\n`);
      console.log(`WRITTEN ${doc.slug}`);
    }
  } catch (err) {
    if (err instanceof StopRun) {
      console.error(`\nSTOPPED: ${err.message}`);
      process.exitCode = 1;
    } else throw err;
  } finally {
    save();
    if (written > 0) await purgeApiCache();
    closeSync(lock!);
    unlinkSync(lockPath);
    console.log(`\n${written} written and verified, ${toReview} to review.${written ? ` Snapshots: ${snapDir}` : ''}`);
  }
}

if (command === 'purge-cache') {
  purgeApiCache()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else if (command !== 'run' || !target) fail('Usage: blog-publish.ts run <rewriteDir> --backup <dir> --by <who> [--confirm] [--only <slug>] [--limit <n>] [--retry-failed]');
else
  run(path.resolve(target)).catch((err) => {
    console.error(err);
    process.exit(1);
  });

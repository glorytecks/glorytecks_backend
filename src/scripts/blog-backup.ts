/**
 * READ-ONLY export of the complete blog dataset — the prerequisite for any
 * content change (docs/BLOG_REMEDIATION_PLAN.md, step 1).
 *
 * Exports every row of `blogs`, `blog_categories` and `authors` exactly as the
 * database holds them — all statuses (draft, published, archived), all columns,
 * original ids, slugs, content blocks, derived html/toc/faqs, author and
 * category relationships, and dates — plus one file per post for easy diffing
 * and a manifest with per-row content checksums.
 *
 * The checksums are what makes rewrites safe: `blog-rewrite.ts` refuses to
 * apply a rewrite to a row whose current content no longer matches the
 * checksum recorded here, so an edit made in the admin panel after the backup
 * can never be silently overwritten.
 *
 * Properties:
 *   • Read-only. The script issues SELECTs only — there is no insert, update,
 *     upsert or delete anywhere in this file.
 *   • Complete. Pages through each table until it is exhausted.
 *   • Deterministic. Rows are sorted by primary key / slug before writing.
 *
 * Usage:
 *   npx tsx src/scripts/blog-backup.ts                  → backups/blog/<timestamp>/
 *   npx tsx src/scripts/blog-backup.ts --out some/dir
 *   npx tsx src/scripts/blog-backup.ts verify <dir>     read-only: proves a backup is
 *       complete and internally consistent (file hashes, per-post files, content
 *       checksums), then compares it with the live table row by row (by id).
 *       Exit code 1 if the backup itself is not usable for recovery.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { supabaseAdmin } from '../config/supabase';
import { contentSha256, sha256, stableStringify } from './lib/blogRewrite';

const PAGE = 1000;

type Row = Record<string, unknown>;

async function selectAll(table: string, orderBy: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select('*')
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < PAGE) return rows;
  }
}

/** The fields a rewrite may change, plus identity: what recovery has to restore. */
const RECOVERY_FIELDS = [
  'id', 'slug', 'title', 'category', 'category_slug', 'author_id', 'author_key', 'excerpt', 'content',
  'date', 'updated', 'status', 'featured_image', 'tags', 'seo_meta_title', 'seo_meta_description',
  'seo_canonical_url', 'seo_og_title', 'seo_og_description', 'seo_og_image', 'seo_keywords', 'seo_noindex',
];
const fingerprint = (row: Row) => sha256(stableStringify(Object.fromEntries(RECOVERY_FIELDS.map((k) => [k, row[k] ?? null]))));

async function verify(dir: string): Promise<number> {
  const problems: string[] = [];
  const read = (file: string) => readFileSync(path.join(dir, file), 'utf8');
  if (!existsSync(path.join(dir, 'manifest.json'))) {
    console.error(`No manifest.json in ${dir}`);
    return 1;
  }
  const manifest = JSON.parse(read('manifest.json')) as {
    createdAt: string;
    counts: { blogs: number };
    files: Record<string, string>;
    rows: { id: string; slug: string; contentSha256: string }[];
  };
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (sha256(read(file)) !== hash) problems.push(`${file}: hash does not match the manifest`);
  }
  const blogs = JSON.parse(read('blogs.json')) as Row[];
  if (blogs.length !== manifest.counts.blogs) problems.push(`blogs.json has ${blogs.length} rows, manifest says ${manifest.counts.blogs}`);
  const ids = new Set(blogs.map((b) => String(b.id)));
  if (ids.size !== blogs.length) problems.push('duplicate ids in blogs.json');
  const bySlugManifest = new Map(manifest.rows.map((r) => [r.slug, r]));
  for (const row of blogs) {
    for (const f of ['id', 'slug', 'title', 'content', 'category_slug', 'date']) {
      if (row[f] === undefined || row[f] === null) problems.push(`${String(row.slug)}: missing ${f}`);
    }
    if (!Array.isArray(row.content) || (row.content as unknown[]).length === 0) problems.push(`${String(row.slug)}: empty content`);
    const m = bySlugManifest.get(String(row.slug));
    if (!m || m.id !== row.id) problems.push(`${String(row.slug)}: not in the manifest with the same id`);
    else if (m.contentSha256 !== contentSha256(row.content)) problems.push(`${String(row.slug)}: content checksum differs from the manifest`);
    const postFile = path.join('posts', `${String(row.slug)}.json`);
    if (!existsSync(path.join(dir, postFile))) problems.push(`${postFile} missing`);
    else if (stableStringify(JSON.parse(read(postFile))) !== stableStringify(row)) problems.push(`${postFile} differs from blogs.json`);
  }

  const live = await selectAll('blogs', 'slug');
  const liveById = new Map(live.map((r) => [String(r.id), r]));
  let same = 0;
  const changed: string[] = [];
  const missing: string[] = [];
  for (const row of blogs) {
    const now = liveById.get(String(row.id));
    if (!now) missing.push(String(row.slug));
    else if (fingerprint(now) === fingerprint(row)) same++;
    else changed.push(String(row.slug));
  }
  const extra = live.filter((r) => !ids.has(String(r.id))).map((r) => String(r.slug));

  console.log(`Backup ${dir} (taken ${manifest.createdAt})`);
  console.log(`  rows: ${blogs.length}; per-post files, content checksums and file hashes checked`);
  console.log(`  integrity problems: ${problems.length}`);
  for (const p of problems.slice(0, 20)) console.log(`    ✗ ${p}`);
  console.log(`  compared with live by id: ${same} identical, ${changed.length} changed since backup, ${missing.length} missing live, ${extra.length} new live`);
  for (const s of changed.slice(0, 20)) console.log(`    changed: ${s}`);
  for (const s of extra.slice(0, 20)) console.log(`    new: ${s}`);
  return problems.length ? 1 : 0;
}

async function main() {
  if (process.argv[2] === 'verify') {
    const dir = process.argv[3];
    if (!dir) throw new Error('Usage: blog-backup.ts verify <backupDir>');
    process.exit(await verify(path.resolve(dir)));
  }
  const outFlag = process.argv.indexOf('--out');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(outFlag > -1 ? process.argv[outFlag + 1] : path.join('backups', 'blog', stamp));
  mkdirSync(path.join(dir, 'posts'), { recursive: true });

  const blogs = await selectAll('blogs', 'slug');
  const categories = await selectAll('blog_categories', 'slug');
  const authors = await selectAll('authors', 'key');

  const write = (file: string, value: unknown) => {
    const body = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(path.join(dir, file), body);
    return sha256(body);
  };

  const files = {
    'blogs.json': write('blogs.json', blogs),
    'blog_categories.json': write('blog_categories.json', categories),
    'authors.json': write('authors.json', authors),
  };
  for (const row of blogs) write(path.join('posts', `${row.slug}.json`), row);

  const byStatus: Record<string, number> = {};
  for (const row of blogs) byStatus[String(row.status)] = (byStatus[String(row.status)] ?? 0) + 1;

  write('manifest.json', {
    createdAt: new Date().toISOString(),
    source: new URL(process.env.SUPABASE_URL ?? 'http://unknown').host,
    readOnly: true,
    counts: { blogs: blogs.length, blog_categories: categories.length, authors: authors.length, byStatus },
    files,
    // Per-row fingerprints: blog-rewrite.ts compares these before any write.
    rows: blogs.map((row) => ({
      id: row.id,
      slug: row.slug,
      status: row.status,
      updated: row.updated,
      updatedAt: row.updated_at,
      contentSha256: contentSha256(row.content),
    })),
  });

  console.log(`Backed up ${blogs.length} blogs (${JSON.stringify(byStatus)}), ${categories.length} categories, ${authors.length} authors → ${dir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

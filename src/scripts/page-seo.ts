/**
 * Page SEO maintenance — export, check, and restore-as-SQL.
 *
 *   npx tsx src/scripts/page-seo.ts export <file.json>
 *       Read-only. Writes every saved page SEO override (page_seo rows, the
 *       /about and course seo groups, comparison meta descriptions) to a JSON
 *       file. Take one before running the rollback script
 *       (supabase/rollbacks/20261015000000_page_seo.down.sql).
 *
 *   npx tsx src/scripts/page-seo.ts check
 *       Read-only. Reports page_seo rows whose path is no longer in the route
 *       registry (they are never served) and values the editor would now refuse.
 *
 *   npx tsx src/scripts/page-seo.ts to-sql <file.json> [out.sql]
 *       No database access. Turns an export into an idempotent SQL restore —
 *       review it, apply it to a local database first, then to the target with
 *       `supabase db execute --file out.sql` or the SQL editor. Nothing is ever
 *       written to a database by this script.
 *
 * There is no backfill to run: an empty page_seo table (and empty seo groups)
 * means every page keeps its current built-in title and description.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  aboutPageRepo,
  comparisonRepo,
  courseRepo,
  pageSeoRepo,
} from '../repositories';
import { PAGE_SEO_PATHS, SEO_LIMITS } from '../seo/pageSeoRegistry';
import { robotsProblem } from '../seo/seoFields';
import { buildRestoreSql, type SeoExport, type SeoExportGroup } from '../seo/pageSeoBackup';

const [command, ...rest] = process.argv.slice(2);

function usage(): never {
  console.error('Usage: page-seo.ts export <file.json> | check | to-sql <file.json> [out.sql]');
  process.exit(2);
}

const group = (g: Record<string, unknown> | null | undefined): SeoExportGroup => ({
  metaTitle: (g?.metaTitle as string) ?? null,
  metaDescription: (g?.metaDescription as string) ?? null,
  ogTitle: (g?.ogTitle as string) ?? null,
  ogDescription: (g?.ogDescription as string) ?? null,
  ogImage: (g?.ogImage as string) ?? null,
  ogImageAlt: (g?.ogImageAlt as string) ?? null,
  keywords: Array.isArray(g?.keywords) ? (g?.keywords as string[]) : [],
  noindex: Boolean(g?.noindex),
  nofollow: Boolean(g?.nofollow),
  intentNote: (g?.intentNote as string) ?? null,
});

async function exportAll(file: string) {
  const [rows, about, courses, comparisons] = await Promise.all([
    pageSeoRepo.findMany({ sort: [{ field: 'path', direction: 1 }] }),
    aboutPageRepo.get(),
    courseRepo.findMany({ sort: [{ field: 'slug', direction: 1 }] }),
    comparisonRepo.findMany({ sort: [{ field: 'slug', direction: 1 }] }),
  ]);
  const data: SeoExport = {
    format: 'glorytecks-page-seo/1',
    exportedAt: new Date().toISOString(),
    pages: rows.map((r) => ({ path: r.path, ...group(r as unknown as Record<string, unknown>) })),
    about: group(about.seo as unknown as Record<string, unknown>),
    courses: courses.map((c) => ({ slug: c.slug, seo: group(c.seo as unknown as Record<string, unknown>) })),
    comparisons: comparisons.map((c) => ({ slug: c.slug, metaDescription: c.metaDescription ?? '' })),
  };
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Exported ${data.pages.length} page override(s), ${data.courses.length} course(s), ${data.comparisons.length} comparison(s) to ${file}.`);
}

async function check() {
  const rows = await pageSeoRepo.findMany({});
  const allowed = new Set(PAGE_SEO_PATHS);
  let problems = 0;
  for (const r of rows) {
    if (!allowed.has(r.path)) {
      problems++;
      console.log(`orphan   ${r.path} — not in the route registry; never served. Export, then delete it from the admin or by SQL.`);
    }
    const robots = robotsProblem(r);
    if (robots) {
      problems++;
      console.log(`robots   ${r.path} — ${robots}`);
    }
    for (const f of ['metaTitle', 'metaDescription', 'ogTitle', 'ogDescription', 'ogImageAlt'] as const) {
      const v = r[f];
      if (typeof v === 'string' && v.length > SEO_LIMITS[f]) {
        problems++;
        console.log(`length   ${r.path} — ${f} is ${v.length} characters (max ${SEO_LIMITS[f]})`);
      }
    }
  }
  console.log(problems ? `\n${problems} problem(s) in ${rows.length} row(s).` : `${rows.length} row(s), no problems.`);
  return problems;
}

function toSql(file: string, out?: string) {
  const plan = buildRestoreSql(JSON.parse(readFileSync(file, 'utf8')) as SeoExport);
  if (out) writeFileSync(out, plan.sql);
  else process.stdout.write(plan.sql);
  console.error(
    `Restore plan: ${plan.counts.pages} page(s), ${plan.counts.about} about, ${plan.counts.courses} course(s), ${plan.counts.comparisons} comparison(s).`,
  );
  for (const s of plan.skipped) console.error(`skipped  ${s}`);
}

async function main() {
  switch (command) {
    case 'export':
      if (!rest[0]) usage();
      await exportAll(rest[0]);
      break;
    case 'check':
      process.exitCode = (await check()) ? 1 : 0;
      break;
    case 'to-sql':
      if (!rest[0]) usage();
      toSql(rest[0], rest[1]);
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});

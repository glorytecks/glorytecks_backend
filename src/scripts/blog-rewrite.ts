/**
 * Read-only planning and rollback for blog rewrites.
 * Writing is done by `blog-publish.ts`, the only script that updates rows.
 *
 * Commands:
 *   plan <dir>                    Read-only. Checks every rewrite file in <dir>
 *                                 against its live row (by id) and prints what a
 *                                 write would change.
 *   rollback <snapshotDir> --confirm
 *                                 Restores rows from the before-snapshots a
 *                                 blog-publish.ts run took, and marks them
 *                                 needs_review in the ledger. Without --confirm
 *                                 it only reports.
 *   Options: --only <slug>        Limit a command to one post.
 *            --ledger <path>      Default content/blog-rewrites/ledger.json.
 *
 * Rollback refuses a row whose content no longer equals what the rewrite
 * wrote, so it cannot overwrite a later edit.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { blogRepo } from '../repositories';
import { blogService } from '../services/blog.service';
import { invalidateResource } from '../lib/cacheInvalidation';
import { validateBlocks } from '../validators/blocks.validator';
import type { IBlog } from '../interfaces/common';
import { ledgerProblem, transition, type Ledger } from './lib/blogStatus';
import {
  planRewrite,
  planRollback,
  rewriteFileProblem,
  rollbackUpdate,
  type LiveRow,
  type PlanResult,
  type RewriteFile,
  type Snapshot,
} from './lib/blogRewrite';

type UpdatePayload = Parameters<typeof blogService.updateBlog>[1];

const args = process.argv.slice(2);
const [command, target] = args;
const confirmed = args.includes('--confirm');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex > -1 ? args[onlyIndex + 1] : undefined;
const ledgerIndex = args.indexOf('--ledger');
const ledgerPath = path.resolve(ledgerIndex > -1 ? args[ledgerIndex + 1] : path.join('content', 'blog-rewrites', 'ledger.json'));

function usage(): never {
  console.error('Usage: tsx src/scripts/blog-rewrite.ts <plan|rollback> <dir> [--confirm] [--only <slug>]');
  process.exit(2);
}

function readJsonFiles<T>(dir: string, suffix: string): Array<{ file: string; value: T }> {
  if (!existsSync(dir)) throw new Error(`No such directory: ${dir}`);
  return readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      return { file, value: JSON.parse(readFileSync(file, 'utf8')) as T };
    });
}

async function liveRow(id: string): Promise<LiveRow | null> {
  const doc = (await blogRepo.findById(id, { detail: true })) as (IBlog & { id?: string }) | null;
  if (!doc) return null;
  return {
    id: String(doc.id),
    slug: doc.slug,
    title: doc.title,
    authorKey: doc.authorKey,
    content: doc.content,
    excerpt: doc.excerpt,
    updated: doc.updated,
    readTime: doc.readTime,
    seo: doc.seo ?? null,
  };
}

function report(result: PlanResult): void {
  console.log(`${result.ok ? 'OK     ' : 'BLOCKED'} ${result.slug}`);
  for (const e of result.errors) console.log(`          ✗ ${e}`);
  for (const n of result.notes) console.log(`          · ${n}`);
}

async function plan(dir: string): Promise<number> {
  const files = readJsonFiles<RewriteFile>(dir, '.json').filter(({ value }) => !only || value?.slug === only);
  let blocked = 0;
  for (const { file, value } of files) {
    const shape = rewriteFileProblem(value);
    if (shape) {
      console.log(`SKIPPED ${path.basename(file)} — ${shape}`);
      blocked += 1;
      continue;
    }
    const result = planRewrite(value, await liveRow(value.id), validateBlocks, false);
    report(result);
    if (!result.ok) blocked += 1;
  }
  console.log(`\nPlan only — nothing written. ${files.length - blocked} would pass these checks, ${blocked} blocked. The full gate runs in blog-publish.ts.`);
  return blocked;
}

async function rollback(dir: string, execute: boolean): Promise<number> {
  const snaps = readJsonFiles<Snapshot>(dir, '.before.json').filter(({ value }) => !only || value.slug === only);
  const ledger = existsSync(ledgerPath) ? (JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger) : null;
  if (ledger && ledgerProblem(ledger)) throw new Error(`Ledger is invalid: ${ledgerProblem(ledger)}`);
  let blocked = 0;
  let restored = 0;
  for (const { value } of snaps) {
    const current = await liveRow(value.id);
    const result = planRollback(value, current);
    report(result);
    if (!result.ok || !current) {
      blocked += 1;
      continue;
    }
    if (!execute) continue;
    await blogService.updateBlog(current.id, rollbackUpdate(value) as UpdatePayload);
    restored += 1;
    console.log('          → restored');
    if (ledger?.articles[value.id]?.status === 'supabase_updated') {
      const err = transition(ledger, value.id, { to: 'needs_review', by: 'blog-rewrite rollback', note: `Rolled back from ${path.basename(dir)}/${value.slug}.before.json`, at: new Date().toISOString() });
      if (err) console.log(`          ! ledger not updated: ${err}`);
      else writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    }
  }
  if (restored > 0) await invalidateResource('blogs');
  console.log(execute ? `\n${restored} restored, ${blocked} blocked.` : `\nPlan only — nothing restored. Add --confirm to restore.`);
  return blocked;
}

async function main() {
  if (!target || !['plan', 'rollback'].includes(command)) usage();
  const dir = path.resolve(target);
  const blocked = command === 'rollback' ? await rollback(dir, confirmed) : await plan(dir);
  process.exit(blocked > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

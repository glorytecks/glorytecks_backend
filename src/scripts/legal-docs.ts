/**
 * Policy pages — compare, back up and (after approval) apply the reviewed text.
 *
 *   npx tsx src/scripts/legal-docs.ts diff
 *       Read-only. Shows, per policy, which fields of the live CMS text differ
 *       from the reviewed draft in src/seed/sitedata/legal.ts.
 *
 *   npx tsx src/scripts/legal-docs.ts export <file.json>
 *       Read-only. Saves the live policy rows to a file.
 *
 *   npx tsx src/scripts/legal-docs.ts apply --effective-date YYYY-MM-DD [--only a,b] [--confirm] [--allow-remote]
 *       Without --confirm: prints what would change and stops.
 *       With --confirm: backs up the live rows to backups/legal/, then writes
 *       the draft text of each policy that differs, sets its "Last updated" to
 *       the effective date (today or later; never earlier than the date the
 *       page already shows), records the SEO change and refreshes the site.
 *       A hosted (non-local) database also needs --allow-remote.
 *
 *   npx tsx src/scripts/legal-docs.ts restore <file.json> --confirm [--allow-remote]
 *       Puts back an exported version, with its own original dates.
 *
 * Apply only after the approvals in main-website/docs/LEGAL_POLICY_REVIEW.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';
import { connectRedis, disconnectRedis } from '../config/redis';
import { legalDocRepo } from '../repositories';
import type { ILegalDoc } from '../interfaces/common';
import { legalDocs } from '../seed/sitedata/legal';
import { ALLOW_REMOTE_FLAG, isLocalSupabaseUrl } from '../seed/guard';
import { applyLegalDocs, effectiveDateProblem, planLegalUpdate, restoreLegalDocs } from './lib/legalDocs';

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(name);
const option = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function requireWritableTarget() {
  const url = env.supabase.url;
  if (!isLocalSupabaseUrl(url) && !flag(ALLOW_REMOTE_FLAG)) {
    fail(
      `Refusing to write to ${new URL(url).host}: it is not a local database. ` +
        `Re-run with ${ALLOW_REMOTE_FLAG} once the change is approved.`,
    );
  }
}

async function liveRows(): Promise<ILegalDoc[]> {
  return legalDocRepo.findMany({ sort: [{ field: 'slug', direction: 1 }] });
}

function backup(rows: ILegalDoc[]): string {
  const dir = path.join(process.cwd(), 'backups', 'legal');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
  return file;
}

async function main() {
  switch (command) {
    case 'diff': {
      for (const p of planLegalUpdate(await liveRows(), legalDocs)) {
        console.log(`${p.slug.padEnd(18)} ${p.action}${p.changed.length ? `: ${p.changed.join(', ')}` : ''}`);
        if (p.action === 'update' && p.headingsBefore.join('|') !== p.headingsAfter.join('|')) {
          console.log(`  sections now: ${p.headingsBefore.join(' · ')}`);
          console.log(`  sections new: ${p.headingsAfter.join(' · ')}`);
        }
      }
      break;
    }
    case 'export': {
      const file = rest[0] ?? fail('Usage: legal-docs.ts export <file.json>');
      const rows = await liveRows();
      writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
      console.log(`Exported ${rows.length} policy page(s) to ${file}.`);
      break;
    }
    case 'apply': {
      const only = option('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
      const drafts = only?.length ? legalDocs.filter((d) => only.includes(d.slug)) : legalDocs;
      if (only?.length && drafts.length !== only.length) fail(`Unknown slug in --only: ${only.join(', ')}`);
      const rows = await liveRows();
      const plans = planLegalUpdate(rows, drafts);
      const effectiveDate = option('--effective-date');
      const problem = effectiveDateProblem(effectiveDate, plans);
      for (const p of plans) console.log(`${p.slug.padEnd(18)} ${p.action}${p.changed.length ? `: ${p.changed.join(', ')}` : ''}`);
      if (problem) fail(problem);
      if (plans.some((p) => p.action === 'missing')) fail('A policy page is missing from the CMS; create it in the admin first.');
      if (!flag('--confirm')) {
        console.log('\nDry run — nothing written. Add --confirm to apply.');
        break;
      }
      requireWritableTarget();
      console.log(`Backup of the live text: ${backup(rows)}`);
      // Connect so the API's cached policy responses are purged with the write.
      await connectRedis();
      const results = await applyLegalDocs({ drafts, effectiveDate: effectiveDate as string, only });
      for (const r of results) console.log(`${r.slug.padEnd(18)} ${r.written ? `written, Last updated ${effectiveDate}` : 'unchanged'}`);
      break;
    }
    case 'restore': {
      const file = rest[0] ?? fail('Usage: legal-docs.ts restore <file.json> --confirm');
      const rows = JSON.parse(readFileSync(file, 'utf8')) as ILegalDoc[];
      if (!flag('--confirm')) fail(`Would restore ${rows.length} policy page(s). Add --confirm to write.`);
      requireWritableTarget();
      console.log(`Backup of the live text: ${backup(await liveRows())}`);
      await connectRedis();
      for (const r of await restoreLegalDocs(rows)) console.log(`${r.slug.padEnd(18)} ${r.written ? 'restored' : 'not found'}`);
      break;
    }
    default:
      fail('Usage: legal-docs.ts diff | export <file> | apply --effective-date YYYY-MM-DD [--only a,b] [--confirm] [--allow-remote] | restore <file> --confirm');
  }
}

// Close connections and let the process end on its own: calling
// process.exit() while a socket is still closing aborts Node on Windows.
main()
  .catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => disconnectRedis().catch(() => undefined));

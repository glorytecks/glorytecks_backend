/**
 * Maintains the blog processing ledger (./lib/blogStatus.ts): one entry per
 * article, keyed by database id, with an append-only history. Local file only;
 * this script never touches the database.
 *
 * Commands (default ledger: content/blog-rewrites/ledger.json):
 *   init --backup <dir> --by <who>        Create a ledger, every article pending.
 *   migrate --by <who>                    Upgrade a version 1 ledger to version 2
 *                                         (keeps history; see migrateV1).
 *   sync-audit <analysis.csv> --by <who>  pending → merge_candidate / noindex_candidate /
 *                                         needs_review per the audit's recommended_action.
 *   mark-rewritten <dir> --by <who>       Every rewrite file in <dir> → rewritten.
 *   set <slug|id> [...] <status> --by <who> --note <why> [--batch <name>]
 *   summary                               Counts per status, and what is still unsettled.
 *   list <status>                         Slugs with that status.
 *   Option: --ledger <path>
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import {
  countByStatus,
  isStatus,
  ledgerProblem,
  migrateV1,
  parseCsv,
  seedLedger,
  statusForAction,
  transition,
  unsettled,
  type Ledger,
} from './lib/blogStatus';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const [command, ...rest] = positional;
const ledgerPath = path.resolve(flag('ledger') ?? path.join('content', 'blog-rewrites', 'ledger.json'));
const by = flag('by') ?? '';
const now = new Date().toISOString();

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function load(): Ledger {
  if (!existsSync(ledgerPath)) fail(`No ledger at ${ledgerPath}.`);
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger;
  const problem = ledgerProblem(ledger);
  if (problem) fail(`Ledger is invalid: ${problem}`);
  return ledger;
}

const save = (ledger: Ledger) => writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
const findId = (ledger: Ledger, key: string) => (ledger.articles[key] ? key : Object.values(ledger.articles).find((e) => e.slug === key)?.id);
const requireBy = () => {
  if (!by.trim()) fail('Say who is making the change: --by <name>');
};
const rewriteFiles = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as { id: string; slug: string; batch?: string; pilot?: string });

switch (command) {
  case 'init': {
    requireBy();
    const backup = flag('backup') ?? fail('init needs --backup <dir>');
    if (existsSync(ledgerPath)) fail(`${ledgerPath} already exists; it is never overwritten.`);
    const rows = JSON.parse(readFileSync(path.join(backup, 'blogs.json'), 'utf8')) as { id: string; slug: string }[];
    save(seedLedger(rows, now, by));
    console.log(`Ledger created with ${rows.length} articles, all pending.`);
    break;
  }
  case 'migrate': {
    requireBy();
    const raw = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    if (raw.version === 2) fail('Ledger is already version 2.');
    const root = path.dirname(ledgerPath);
    const rewritten = new Set(
      readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) => rewriteFiles(path.join(root, d.name)).map((f) => f.id)),
    );
    writeFileSync(`${ledgerPath}.v1.json`, `${JSON.stringify(raw, null, 2)}\n`);
    const v2 = migrateV1(raw, rewritten, now, by);
    const problem = ledgerProblem(v2);
    if (problem) fail(`Migration produced an invalid ledger: ${problem}`);
    save(v2);
    console.log(`Migrated to version 2 (v1 kept at ${path.basename(ledgerPath)}.v1.json).`, countByStatus(v2));
    break;
  }
  case 'sync-audit': {
    requireBy();
    const ledger = load();
    const rows = parseCsv(readFileSync(rest[0] ?? fail('sync-audit needs the analysis CSV path'), 'utf8'));
    let moved = 0;
    for (const row of rows) {
      const entry = ledger.articles[row.id];
      if (!entry || entry.status !== 'pending') continue;
      const to = statusForAction(row.recommended_action ?? '');
      if (to === 'pending') continue;
      const err = transition(ledger, row.id, { to, by, note: `Audit: ${row.recommended_action} (${row.action_reason ?? ''})`, at: now });
      if (err) fail(err);
      moved++;
    }
    save(ledger);
    console.log(`${moved} articles classified.`, countByStatus(ledger));
    break;
  }
  case 'mark-rewritten': {
    requireBy();
    const ledger = load();
    const dir = path.resolve(rest[0] ?? fail('mark-rewritten needs a rewrite directory'));
    for (const doc of rewriteFiles(dir)) {
      const entry = ledger.articles[doc.id] ?? fail(`${doc.slug}: id ${doc.id} is not in the ledger`);
      if (entry.status === 'rewritten') continue;
      const err = transition(ledger, doc.id, { to: 'rewritten', by, note: `Rewrite saved as ${path.basename(dir)}/${doc.slug}.json`, at: now, batch: doc.batch ?? doc.pilot ?? path.basename(dir) });
      if (err) fail(err);
      if (!entry.startedAt) entry.startedAt = now;
    }
    save(ledger);
    console.log(countByStatus(ledger));
    break;
  }
  case 'set': {
    requireBy();
    const note = flag('note') ?? '';
    const status = rest[rest.length - 1];
    const keys = rest.slice(0, -1);
    if (!isStatus(status) || keys.length === 0) fail('Usage: set <slug|id> [...] <status> --by <who> --note <why>');
    const ledger = load();
    for (const key of keys) {
      const id = findId(ledger, key) ?? fail(`Unknown article: ${key}`);
      const err = transition(ledger, id, { to: status, by, note, at: now, batch: flag('batch') });
      if (err) fail(err);
    }
    save(ledger);
    console.log(`${keys.length} article(s) → ${status}`);
    break;
  }
  case 'summary': {
    const ledger = load();
    console.log(countByStatus(ledger));
    console.log(`unsettled: ${unsettled(ledger).length}`);
    break;
  }
  case 'list': {
    const ledger = load();
    for (const e of Object.values(ledger.articles).filter((x) => x.status === rest[0]).sort((a, b) => a.slug.localeCompare(b.slug))) console.log(e.slug);
    break;
  }
  default:
    fail('Usage: blog-status.ts <init|migrate|sync-audit|mark-rewritten|set|summary|list> … (see the header of this file)');
}

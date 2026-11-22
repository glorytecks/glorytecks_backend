import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ALLOW_REMOTE_FLAG,
  ALLOW_REMOTE_WIPE_FLAG,
  isLocalSupabaseUrl,
  seedTargetRefusal,
} from '../src/seed/guard';

/**
 * Database guardrails: no reset, no production overwrite, no schema
 * destruction (programme rule, A1 2026-10-15).
 *
 *  • Applied migrations are immutable. Supabase records a migration by its
 *    version and never re-runs it, so editing one silently forks the schema
 *    between environments. Each file's content hash is pinned below; a change
 *    goes in a NEW migration.
 *  • A new migration may not drop, truncate or delete unless it carries the
 *    line `-- guardrail: destructive-approved <reason>` — the destructive step
 *    is then a reviewed decision with a rollback plan, not an accident.
 *  • `npm run seed` refuses a non-local Supabase (src/seed/guard.ts).
 */

const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const read = (file: string) => readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').replace(/\r\n/g, '\n');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Content hashes (LF line endings) of every migration applied to Glorytecks-main (last added 2026-10-25). */
const APPLIED_MIGRATIONS: Record<string, string> = {
  '20260101000000_initial_schema.sql': 'efa101b465e5a4eb69d3202badb0d4e7a682341009b7f3f643f5afff192e6e91',
  '20260101000100_singletons.sql': 'cd96b804135d5a05014c961b705c72c4d867ce9aebb63e18cbbad1cca1b22a83',
  '20260101000200_indexes.sql': '3d7ece46af59d9ab548598cdf7460c449d15cad52de0b43de01c084dafb6e5e7',
  '20260101000300_functions.sql': 'e46093721ca1541b04f7026c83e3eb9b0675b6466f9ef92bec3cffef6c926e33',
  '20260101000400_rls.sql': 'c11601c283586c1822aa615a1aa195338170d3e2430d995a45077b118bf015cc',
  '20261003000000_course_categories.sql': '496d974d8e44cebc5cd282ac253d584a845982d25ef54cd7c3621bb81217fe6f',
  '20261010000000_course_nav_menu.sql': '6e6542b311caaf40914979c32ea0fea77985427a635d1f80475d72e1e35833db',
  '20261014000000_chat_enquiries.sql': 'a5b37aa9c9ec9ded428feefa774a32f162b711b424c9da631a2449b1b70f0967',
  // Applied to Glorytecks-main on 2026-10-15 (A4 page SEO).
  '20261015000000_page_seo.sql': '2df643a17794cc3ab73ad02b6091117f6f578b90dad1ca33199df7ad68093396',
  // Already applied when checked on 2026-10-25 (supabase db push --dry-run listed it as done).
  '20261016000000_settings_contact_defaults.sql': 'db1cdb06f5f06789dc989db290b63d0357926991c65d147bbfb2134b4f685560',
  // Applied to Glorytecks-main on 2026-10-25 (admin upgrade Phase 2 refresh log, Phase 3 SEO audit).
  '20261024000000_site_refresh_log.sql': '731d898f2b7d1a23367ff3d2dc5acd14d8d95fc082290b2fd2ca6043bd91e597',
  '20261025000000_site_audit.sql': 'c0400c1ee187637dbec84ec586ff91799a5c4a70f7854d617d81fab4df446f10',
};

const APPROVAL_MARKER = /^\s*--\s*guardrail:\s*destructive-approved\s+\S/m;
const DESTRUCTIVE =
  /\bdrop\s+(?:table|column|schema|database|type|view|materialized\s+view|function|index|policy|trigger|constraint)\b|\btruncate\b|\bdelete\s+from\b|\balter\s+table\b[^;]*\bdrop\b/i;

/** SQL without comments, so a commented-out statement is not flagged. */
const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('applied migrations are unchanged — schema changes go in a new migration', () => {
  for (const [file, hash] of Object.entries(APPLIED_MIGRATIONS)) {
    assert.equal(sha256(read(file)), hash, `${file} was edited after being applied`);
  }
});

test('no applied migration has been deleted', () => {
  const present = new Set(readdirSync(MIGRATIONS_DIR));
  for (const file of Object.keys(APPLIED_MIGRATIONS)) {
    assert.ok(present.has(file), `${file} was removed`);
  }
});

test('a new migration contains no destructive SQL without an approval marker', () => {
  const added = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && !(f in APPLIED_MIGRATIONS));
  for (const file of added) {
    const sql = read(file);
    if (APPROVAL_MARKER.test(sql)) continue;
    const hit = stripComments(sql).match(DESTRUCTIVE);
    assert.equal(hit, null, `${file}: "${hit?.[0]}" needs "-- guardrail: destructive-approved <reason>"`);
  }
});

test('the destructive-SQL check recognises what it must and ignores comments', () => {
  for (const sql of ['drop table x;', 'TRUNCATE t;', 'delete from leads;', 'alter table a drop column b;']) {
    assert.match(stripComments(sql), DESTRUCTIVE, sql);
  }
  for (const sql of ['-- drop table x', '/* truncate t */', 'create table t (id int);', 'alter table a add column b text;']) {
    assert.doesNotMatch(stripComments(sql), DESTRUCTIVE, sql);
  }
});

test('isLocalSupabaseUrl only accepts a local stack', () => {
  assert.equal(isLocalSupabaseUrl('http://127.0.0.1:54321'), true);
  assert.equal(isLocalSupabaseUrl('http://localhost:54321'), true);
  assert.equal(isLocalSupabaseUrl('https://abcdefgh.supabase.co'), false);
  assert.equal(isLocalSupabaseUrl('https://localhost.evil.example'), false);
  assert.equal(isLocalSupabaseUrl('not a url'), false);
});

const remote = 'https://abcdefgh.supabase.co';

test('seed proceeds against a local stack without flags', () => {
  assert.equal(seedTargetRefusal({ supabaseUrl: 'http://127.0.0.1:54321', argv: [], isProd: false, wipe: true }), null);
});

test('seed refuses a hosted project unless --allow-remote is given', () => {
  const refusal = seedTargetRefusal({ supabaseUrl: remote, argv: [], isProd: false, wipe: false });
  assert.ok(refusal);
  assert.match(refusal, /abcdefgh\.supabase\.co/);
  assert.equal(seedTargetRefusal({ supabaseUrl: remote, argv: [ALLOW_REMOTE_FLAG], isProd: false, wipe: false }), null);
});

test('--fresh against a hosted project needs a second, explicit flag', () => {
  assert.ok(seedTargetRefusal({ supabaseUrl: remote, argv: [ALLOW_REMOTE_FLAG], isProd: false, wipe: true }));
  assert.equal(
    seedTargetRefusal({
      supabaseUrl: remote,
      argv: [ALLOW_REMOTE_FLAG, ALLOW_REMOTE_WIPE_FLAG],
      isProd: false,
      wipe: true,
    }),
    null,
  );
});

test('NODE_ENV=production counts as remote even with a local URL', () => {
  assert.ok(seedTargetRefusal({ supabaseUrl: 'http://127.0.0.1:54321', argv: [], isProd: true, wipe: false }));
});

test('seed.ts checks its target before any write', () => {
  const src = readFileSync(path.join(__dirname, '..', 'src', 'seed', 'seed.ts'), 'utf8');
  const run = src.slice(src.indexOf('async function run()'));
  const guardAt = run.indexOf('seedTargetRefusal(');
  assert.ok(guardAt > 0, 'run() must call seedTargetRefusal');
  for (const write of ['wipe()', 'seedAdmin()', 'seedSettings()']) {
    assert.ok(run.indexOf(write) > guardAt, `${write} must come after the target check`);
  }
});

/**
 * Re-derive the stored `html` (and toc/faqs) of blog rows whose html no longer
 * matches what the current renderer produces from their unchanged content.
 * Used after the inline-renderer fix in utils/blocks.ts (code spans containing
 * ** were paired into <strong> tags that crossed them).
 *
 *   npx tsx src/scripts/blog-rerender.ts [--status supabase_updated] [--ledger <path>] [--confirm]
 *
 * Without --confirm it only reports. With it, each differing row's old html is
 * saved to backups/blog-rerender/<stamp>/<slug>.html, the row is re-saved
 * through BlogService.updateBlog with its own content (the `updated` date and
 * everything else stay as they are), and the result is read back and compared.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { supabaseAdmin } from '../config/supabase';
import { blogService, deriveContentFields } from '../services/blog.service';
import type { Block } from '../utils/blocks';
import type { Ledger } from './lib/blogStatus';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
};
const confirm = argv.includes('--confirm');
const wanted = flag('status') ?? 'supabase_updated';
const ledgerPath = path.resolve(flag('ledger') ?? path.join('content', 'blog-rewrites', 'ledger.json'));

async function main() {
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger;
  const ids = Object.values(ledger.articles).filter((e) => e.status === wanted).map((e) => e.id);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve('backups', 'blog-rerender', stamp);
  let differing = 0;
  let fixed = 0;
  for (const id of ids) {
    const { data, error } = await supabaseAdmin.from('blogs').select('id,slug,content,html,updated,read_time').eq('id', id);
    if (error || !data || data.length !== 1) throw new Error(`read ${id}: ${error?.message ?? `${data?.length ?? 0} rows`}`);
    const row = data[0] as { id: string; slug: string; content: Block[]; html: string; updated: string; read_time: string };
    const expected = deriveContentFields(row.content).html;
    if (expected === row.html) continue;
    differing++;
    console.log(`${confirm ? 'RERENDER' : 'DIFFERS '} ${row.slug}`);
    if (!confirm) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${row.slug}.html`), row.html ?? '');
    await blogService.updateBlog(id, { content: row.content, readTime: row.read_time } as never);
    const after = await supabaseAdmin.from('blogs').select('html,updated').eq('id', id).single();
    if (after.error) throw new Error(`read back ${row.slug}: ${after.error.message}`);
    if (after.data.html !== expected || after.data.updated !== row.updated) throw new Error(`read back ${row.slug}: html or updated date mismatch`);
    fixed++;
  }
  console.log(`\n${ids.length} checked, ${differing} differ${confirm ? `, ${fixed} re-rendered and verified${fixed ? ` (old html in ${dir})` : ''}` : ' (report only)'}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

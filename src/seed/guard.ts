/**
 * Where `npm run seed` is allowed to write.
 *
 * The seed upserts courses, legal pages, localities and the Settings singleton
 * from the files in ./sitedata, and `--fresh` deletes every content row first.
 * Pointed at the hosted project — which is exactly what a developer `.env`
 * with the cloud SUPABASE_URL does — one routine-sounding command would
 * overwrite the live CMS (address, claims, legal text) or empty it.
 *
 * So a seed only runs against a local Supabase stack unless the operator says
 * otherwise, explicitly, twice over for a wipe:
 *
 *   --allow-remote        write to a non-local project (upserts only)
 *   --allow-remote-wipe   additionally allow `--fresh` against it
 *
 * NODE_ENV=production is treated as remote whatever the URL says.
 *
 * Pure (no env, no I/O) so the rule is unit-tested in tests/guardrails.test.ts.
 */

export const ALLOW_REMOTE_FLAG = '--allow-remote';
export const ALLOW_REMOTE_WIPE_FLAG = '--allow-remote-wipe';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

/** True for a Supabase URL served by the local CLI stack (`supabase start`). */
export function isLocalSupabaseUrl(raw: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(raw).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Why this seed run must not proceed, or null when it may.
 * The message names the host (never a key) and the flag that would allow it.
 */
export function seedTargetRefusal(opts: {
  supabaseUrl: string;
  argv: readonly string[];
  isProd: boolean;
  wipe: boolean;
}): string | null {
  const local = isLocalSupabaseUrl(opts.supabaseUrl) && !opts.isProd;
  if (local) return null;

  let host = '(unparseable SUPABASE_URL)';
  try {
    host = new URL(opts.supabaseUrl).hostname;
  } catch {
    /* keep the placeholder */
  }

  if (!opts.argv.includes(ALLOW_REMOTE_FLAG)) {
    return [
      `Refusing to seed ${host}: it is not a local Supabase stack${opts.isProd ? ' (NODE_ENV=production)' : ''}.`,
      'The seed overwrites courses, legal pages, localities and Settings with the defaults in src/seed/sitedata.',
      `Use a local stack (\`supabase start\`), or re-run with ${ALLOW_REMOTE_FLAG} if that is genuinely intended.`,
    ].join('\n');
  }

  if (opts.wipe && !opts.argv.includes(ALLOW_REMOTE_WIPE_FLAG)) {
    return [
      `Refusing to run --fresh against ${host}: it deletes every content row before re-seeding.`,
      `Add ${ALLOW_REMOTE_WIPE_FLAG} as well if you really mean to empty a non-local database.`,
    ].join('\n');
  }

  return null;
}

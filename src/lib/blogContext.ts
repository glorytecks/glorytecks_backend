/**
 * Post context helpers: the neighbours and related posts shown under an
 * article (GET /public/blogs/:slug/context). Pure, so the rules are tested
 * without a database (tests/blogContext.test.ts).
 *
 * Why not "date before / date after": 521 of 643 posts share one `date`, so a
 * strict date comparison skipped every one of them — all ~40 posts of a
 * category pointed at the same neighbour and none linked to each other. The
 * category is read once in the repository's total order (date, then id) and
 * neighbours are decided by position in it.
 */

export interface PoolPost {
  slug: string;
  title: string;
  tags?: string[] | null;
}

export interface Neighbours {
  /** The next older post in the category, or null at the end. */
  prev: { slug: string; title: string } | null;
  /** The next newer post in the category, or null at the start. */
  next: { slug: string; title: string } | null;
}

/** `pool` is the category newest-first, in one total order. */
export function neighboursOf(pool: readonly PoolPost[], slug: string): Neighbours {
  const at = pool.findIndex((p) => p.slug === slug);
  const pick = (i: number) => (at >= 0 && i >= 0 && i < pool.length ? { slug: pool[i].slug, title: pool[i].title } : null);
  return { prev: pick(at + 1), next: pick(at - 1) };
}

/** FNV-1a, 32-bit: a stable, well-spread number for a pair of slugs. */
function spreadKey(a: string, b: string): number {
  let h = 0x811c9dc5;
  const s = `${a}|${b}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The `count` most related posts in the category: most shared tags first.
 * Equal scores are ordered by a per-pair hash instead of recency, so every
 * post in the category can be recommended — before, only the 12 newest could
 * ever appear — while each page keeps the same list on every render.
 */
export function rankRelated(post: { slug: string; tags?: string[] | null }, pool: readonly PoolPost[], count = 3): string[] {
  const tags = new Set((post.tags ?? []).map((t) => t.toLowerCase()));
  return pool
    .filter((c) => c.slug !== post.slug)
    .map((c) => ({
      slug: c.slug,
      score: (c.tags ?? []).filter((t) => tags.has(t.toLowerCase())).length,
      spread: spreadKey(post.slug, c.slug),
    }))
    .sort((a, b) => b.score - a.score || a.spread - b.spread || a.slug.localeCompare(b.slug))
    .slice(0, count)
    .map((x) => x.slug);
}

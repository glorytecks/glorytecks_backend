/**
 * A title that ends in a bare number its slug does not also end in.
 *
 * Root cause of "Mock Interview Guide: Practising Out Loud the Right Way 10":
 * one CMS save (2026-09-23 16:07 UTC, the only row edited after the import)
 * changed the title column alone. The slug, SEO title, OG title, excerpt and
 * body all kept the original wording, and nothing checked the title against
 * them. A number that belongs in the title ("Top 10", "Part 2") also appears in
 * the slug generated from it, so this check rejects the stray suffix and
 * nothing legitimate.
 */
export function strayTrailingNumber(title: string, slug: string): string | null {
  const m = title.trim().match(/\s(\d{1,3})$/);
  if (!m) return null;
  return slug.endsWith(`-${m[1]}`) ? null : m[1];
}

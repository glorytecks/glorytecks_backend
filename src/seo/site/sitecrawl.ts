// ─────────────────────────────────────────────────────────────────────────────
// GENERATED COPY — do not edit here. Every declaration below is copied verbatim
// from main-website/lib/seo/sitecrawl.live.test.ts (the site deploys separately, so the
// backend cannot import it). main-website/lib/seo/auditParity.test.ts fails if
// any of them differs from the site's, or if this file declares anything the
// site file does not. Change the site file, then copy the declaration across.
// ─────────────────────────────────────────────────────────────────────────────

/** Clean URLs and ?page=N archives are pages; any other query is a variant (POLICY_PROBES). */
/** /blog?page=N or /blog/category/x?page=N, N ≥ 2. */
const isArchiveSlice = (p: string) => /^\/blog(\/category\/[^/?]+)?\?page=([2-9]|\d{2,})$/.test(p);

const crawlable = (p: string) => {
  const [, query] = p.split('?');
  return !query || [...new URLSearchParams(query).keys()].every((k) => k === 'page');
};

export { isArchiveSlice, crawlable };

// ─────────────────────────────────────────────────────────────────────────────
// GENERATED COPY — do not edit here. Every declaration below is copied verbatim
// from main-website/lib/guardrails/claimPatterns.ts (the site deploys separately, so the
// backend cannot import it). main-website/lib/seo/auditParity.test.ts fails if
// any of them differs from the site's, or if this file declares anything the
// site file does not. Change the site file, then copy the declaration across.
// ─────────────────────────────────────────────────────────────────────────────

// Claim patterns for the A12 truth scan (lib/seo/pageAudit.ts → truthScan).
// They are detectors, so they live here with the other guardrails, outside the
// claims ratchet's scan (lib/guardrails/scope.test.ts excludes this folder).

/**
 * Claim patterns the A12 truth scan reports. They are not all wrong: a claim
 * the business has independently verified stays. The scan gives each hit its
 * context and its zone so a person can decide.
 */
export const CLAIM_PATTERNS: readonly [string, RegExp][] = [
  ['100%', /\b100\s?%/gi],
  ['500+', /\b500\s?\+/g],
  ['4.9 rating', /\b4\.9\b/g],
  ['#1 / number one', /#\s?1\b|\bnumber one\b|\bno\.\s?1\b/gi],
  ['guarantee', /\bguarantee[ds]?\b/gi],
  ['hiring partners', /\bhiring partners?\b|\bplacement partners?\b|\b\d+\+?\s+(?:companies|recruiters)\b/gi],
  ['near a non-centre locality', /\bnear\s+(?:the\s+)?(?:kukatpally|kphb|madhapur|gachibowli|hitec(?:h)?\s*city|dilsukhnagar|miyapur|secunderabad|kondapur|uppal|lb nagar)\b/gi],
  ['EMI / fee / price', /\bEMI\b|₹\s?\d|\bRs\.?\s?\d|\bscholarships?\b/g],
  ['certificate claim', /\bindustry[- ]recogni[sz]ed\b|\bglobally recogni[sz]ed\b|\bcertification assistance\b|\baccredited\b/gi],
  ['salary / hike', /\bLPA\b|\bsalary hike\b|\b\d+x\s*[-–—]\s*\d+x\b|\baverage salary\b/gi],
  ['placement outcome', /\bplacement rate\b|\b\d[\d,]*\+\s+(?:students|learners|alumni)\b|\bstudents placed\b|\b\d+\s?%\s+(?:placement|placed)\b/gi],
  ['old date', /\bJune 10\b|\b20(?:1\d|2[0-5])\b/g],
];

/** An explicit "not a guarantee" statement around a "guarantee" hit. */
export const CLAIM_DISCLAIMER = /\b(?:not|never|no|without|doesn['’]?t|does not)\s+(?:a\s+|any\s+)?guarantee/i;

/** Patterns an explicit disclaimer around the hit cancels ("not a guarantee of a job"). */
export const DISCLAIMABLE: ReadonlySet<string> = new Set(['guarantee']);

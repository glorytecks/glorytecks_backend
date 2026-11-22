/**
 * robots.txt as the audit crawler obeys it (RFC 9309).
 *
 * The site's own check of robots.txt (copied from the site, seo/site/smoke.ts →
 * checkRobotsTxt) asks whether the file invites search engines and lists the
 * sitemap. This module answers a different question: may THIS crawler fetch a
 * given path? The audit asks it before every page it requests.
 *
 * Group selection: the group naming our product token wins, otherwise "*".
 * Rule matching: the longest matching path wins; on a tie, Allow wins. `*`
 * matches any run of characters and a trailing `$` anchors the end.
 */

export const AUDIT_ROBOTS_TOKEN = 'GloryTecksSEOAudit';

interface Rule {
  allow: boolean;
  pattern: string;
}

export interface RobotsPolicy {
  /** Rules that apply to this crawler (its own group, else "*"). */
  rules: Rule[];
  /** Sitemap URLs the file lists. */
  sitemaps: string[];
}

export function parseRobots(text: string, token: string = AUDIT_ROBOTS_TOKEN): RobotsPolicy {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const at = line.indexOf(':');
    if (at === -1) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      // An empty Disallow allows everything: it adds no rule.
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
    }
  }

  const own = groups.filter((g) => g.agents.includes(token.toLowerCase()));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  return { rules: chosen.flatMap((g) => g.rules), sitemaps };
}

function patternRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** May the audit crawler fetch this path (+ query)? */
export function robotsAllows(policy: RobotsPolicy, pathAndQuery: string): boolean {
  if (pathAndQuery === '/robots.txt') return true;
  let best: Rule | null = null;
  for (const rule of policy.rules) {
    if (!patternRegex(rule.pattern).test(pathAndQuery)) continue;
    const longer = !best || rule.pattern.length > best.pattern.length;
    const tieAllow = best && rule.pattern.length === best.pattern.length && rule.allow && !best.allow;
    if (longer || tieAllow) best = rule;
  }
  return best ? best.allow : true;
}

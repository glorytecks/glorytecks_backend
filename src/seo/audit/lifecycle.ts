import { SEVERITY_RANK } from './rules';
import type { AuditFinding } from './analyze';

/**
 * How one run's findings change the stored issues. Pure: the existing issues
 * and the findings go in, the rows to write come out.
 *
 *   • An issue is one fingerprint (origin + rule + path + target), stored once
 *     however many runs report it.
 *   • first_seen / first_run never change; last_seen / last_run move to the
 *     latest run that reported it, and times_seen counts those runs.
 *   • Analysing the same run again (after "retry failed checks") updates the
 *     evidence but does not count the run twice.
 *   • An open issue the run did not report is resolved only if the run looked
 *     at what it is about (`evaluated`). Anything the run did not reach stays
 *     as it was.
 *   • A resolved issue reported again is reopened and counted as such —
 *     unless it was resolved by this same run, which a re-analysis corrects.
 */

export interface StoredIssue {
  id: string;
  fingerprint: string;
  rule: string;
  path: string;
  status: 'open' | 'resolved';
  timesSeen: number;
  reopenedCount: number;
  firstRunId: string | null;
  lastRunId: string | null;
  resolvedRunId: string | null;
  firstSeenAt: string;
}

export interface KeyedFinding extends AuditFinding {
  fingerprint: string;
  adminPath: string | null;
}

export interface LifecyclePlan {
  /** Full rows to upsert on `fingerprint`: every issue this run reported. */
  upserts: Record<string, unknown>[];
  /** Ids of open issues to mark resolved. */
  resolve: string[];
  counts: { new: number; recurring: number; reopened: number; resolved: number };
}

export function planLifecycle(
  existing: readonly StoredIssue[],
  findings: readonly KeyedFinding[],
  run: { id: string; at: string; origin: string },
  evaluated: (rule: string, path: string) => boolean,
): LifecyclePlan {
  const byFingerprint = new Map(existing.map((i) => [i.fingerprint, i]));
  const reported = new Set<string>();
  const plan: LifecyclePlan = { upserts: [], resolve: [], counts: { new: 0, recurring: 0, reopened: 0, resolved: 0 } };

  for (const f of findings) {
    if (reported.has(f.fingerprint)) continue;
    reported.add(f.fingerprint);
    const prev = byFingerprint.get(f.fingerprint);
    const sameRun = prev?.lastRunId === run.id;
    const reopened = prev?.status === 'resolved' && prev.resolvedRunId !== run.id;

    plan.upserts.push({
      fingerprint: f.fingerprint,
      origin: run.origin,
      rule: f.rule,
      category: f.category,
      severity: f.severity,
      severity_rank: SEVERITY_RANK[f.severity],
      path: f.path,
      target: f.target,
      page_type: f.pageType,
      detail: f.detail,
      evidence: f.evidence,
      affected: f.affected,
      affected_count: f.affectedCount,
      admin_path: f.adminPath,
      status: 'open',
      resolved_at: null,
      resolved_run_id: null,
      first_seen_at: prev?.firstSeenAt ?? run.at,
      first_run_id: prev ? prev.firstRunId : run.id,
      last_seen_at: run.at,
      last_run_id: run.id,
      times_seen: prev ? (sameRun ? prev.timesSeen : prev.timesSeen + 1) : 1,
      reopened_count: (prev?.reopenedCount ?? 0) + (reopened ? 1 : 0),
    });

    if (!prev || prev.firstRunId === run.id) plan.counts.new++;
    else plan.counts.recurring++;
    if (reopened) plan.counts.reopened++;
  }

  for (const prev of existing) {
    if (prev.status !== 'open' || reported.has(prev.fingerprint)) continue;
    if (!evaluated(prev.rule, prev.path)) continue;
    plan.resolve.push(prev.id);
    plan.counts.resolved++;
  }

  return plan;
}

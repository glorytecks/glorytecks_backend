import { ApiError } from '../utils/ApiError';
import { logger } from '../config/logger';
import type { ContentStatus } from '../constants';
import type { ChangeContext } from './siteRevalidation';
import { invalidateResourceChanges } from './cacheInvalidation';

/**
 * Changing the status of several records at once (admin lists: "Publish",
 * "Move to draft", "Archive" for the selected rows).
 *
 * Each record goes through its module's own single-record code — the same
 * service call, the same audit — exactly as if it had been saved on its own.
 * What is shared is the after-effect: Redis is purged once, the site is told
 * once with every record's tags, and IndexNow gets one submission
 * (invalidateResourceChanges). Saved one by one, 66 records were 66 site
 * refreshes, 66 refresh-log rows and 66 IndexNow submissions.
 */

/** Records per request: the admin's largest page size. */
export const BULK_STATUS_MAX = 100;

/** Records worked on at the same time: bounded, never one request per record at once. */
const CONCURRENCY = 4;

export interface BulkStatusResult {
  status: ContentStatus;
  /** Records whose status changed. */
  updated: string[];
  /** Records already in that status: nothing written. */
  unchanged: string[];
  /** Records that could not be changed, with a reason safe to show. */
  failed: { id: string; message: string }[];
}

interface BulkStatusOptions<T> {
  /** The resource's invalidation name (lib/cacheInvalidation INVALIDATION_MAP). */
  resource: string;
  ids: readonly string[];
  status: ContentStatus;
  /** The record as it is now, or null if there is none. */
  load: (id: string) => Promise<T | null>;
  /** The module's single-record status change; returns the saved record. */
  save: (id: string, status: ContentStatus, before: T) => Promise<T>;
}

/** A 4xx is a message written for the editor; anything else is not shown. */
function reasonOf(err: unknown): string {
  if (err instanceof ApiError && err.statusCode < 500) return err.message;
  return 'Could not be changed. Please try again.';
}

export async function bulkSetStatus<T extends { status?: unknown }>(opts: BulkStatusOptions<T>): Promise<BulkStatusResult> {
  const ids = [...new Set(opts.ids)];
  const result: BulkStatusResult = { status: opts.status, updated: [], unchanged: [], failed: [] };
  const changes: ChangeContext[] = [];

  const one = async (id: string) => {
    try {
      const before = await opts.load(id);
      if (!before) {
        result.failed.push({ id, message: 'Not found' });
        return;
      }
      if (before.status === opts.status) {
        result.unchanged.push(id);
        return;
      }
      const after = await opts.save(id, opts.status, before);
      changes.push({
        before: before as unknown as Record<string, unknown>,
        after: after as unknown as Record<string, unknown>,
      });
      result.updated.push(id);
    } catch (err) {
      if (!(err instanceof ApiError) || err.statusCode >= 500) {
        logger.error('Bulk status change failed for one record', {
          resource: opts.resource,
          id,
          message: (err as Error)?.message,
        });
      }
      result.failed.push({ id, message: reasonOf(err) });
    }
  };

  // A small pool: never more than CONCURRENCY records in flight.
  let next = 0;
  const worker = async () => {
    while (next < ids.length) await one(ids[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));

  if (changes.length > 0) await invalidateResourceChanges(opts.resource, changes);

  // Back in the order the editor selected them.
  const order = new Map(ids.map((id, i) => [id, i]));
  result.updated.sort((a, b) => order.get(a)! - order.get(b)!);
  result.unchanged.sort((a, b) => order.get(a)! - order.get(b)!);
  result.failed.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return result;
}

import { logger } from '../config/logger';
import { seoAuditRepo } from '../repositories';
import type { SeoAuditEntity } from '../interfaces/common';

/**
 * Record that an editor changed a page's SEO fields.
 *
 * Stores the page's path, the record id (when the page is record-backed), the
 * editor's id, the action and the NAMES of the changed fields — never their
 * values, so the log cannot leak page content, form submissions or secrets.
 *
 * Never throws: the edit has already been saved, and failing the request over
 * a lost audit row would only make the editor retry a write that succeeded.
 * A failure is logged so it is visible in the backend's logs.
 */
export async function recordSeoAudit(entry: {
  entityType: SeoAuditEntity;
  entityKey: string;
  recordId?: string | null;
  action: 'create' | 'update' | 'delete';
  changedFields: readonly string[];
  editorId?: string | null;
}): Promise<void> {
  if (entry.action === 'update' && entry.changedFields.length === 0) return;
  try {
    await seoAuditRepo.insertRaw({
      entity_type: entry.entityType,
      entity_key: entry.entityKey,
      record_id: entry.recordId ?? null,
      action: entry.action,
      changed_fields: [...entry.changedFields],
      editor_id: entry.editorId ?? null,
    });
  } catch (err) {
    logger.warn('SEO audit entry could not be written', {
      entityType: entry.entityType,
      entityKey: entry.entityKey,
      action: entry.action,
      reason: (err as Error).message,
    });
  }
}

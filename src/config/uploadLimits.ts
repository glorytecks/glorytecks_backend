/**
 * Upload size limits the hosting platform can actually deliver.
 *
 * Vercel rejects a Function request whose body is over 4.5 MB before any of
 * this API's code runs: `413 FUNCTION_PAYLOAD_TOO_LARGE`, a plain-text reply
 * with no CORS headers. The admin's browser therefore sees no response at all
 * and shows "Upload failed — check your connection", while the configured
 * limits (20 MB for documents, 8 MB for images) told it the file was fine.
 * Reproduced against the live API on 2026-11-09: a 1 KB upload got the app's
 * own answer, a 5 MB upload got Vercel's 413.
 *
 * On Vercel (`VERCEL=1`, set at build and run time) every per-file limit is
 * therefore capped at 4 MB, which leaves room for the multipart envelope. The
 * admin reads the limits from GET /uploads/config and refuses a larger file
 * with "That file is 6MB. The limit is 4MB." before sending it. Elsewhere
 * (local development, tests) the configured limits apply unchanged.
 */
export const VERCEL_UPLOAD_CAP_BYTES = 4 * 1024 * 1024;

export function platformUploadLimit(configured: number, onVercel: boolean = Boolean(process.env.VERCEL)): number {
  return onVercel ? Math.min(configured, VERCEL_UPLOAD_CAP_BYTES) : configured;
}

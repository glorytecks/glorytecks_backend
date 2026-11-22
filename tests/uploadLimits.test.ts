import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { platformUploadLimit, VERCEL_UPLOAD_CAP_BYTES } from '../src/config/uploadLimits';
import { env } from '../src/config/env';

/**
 * Vercel refuses a Function request body over 4.5 MB with a CORS-less 413, so
 * the admin saw "check your connection" for a 5 MB brochure (2026-11-09). The
 * limits advertised by /uploads/config must be ones the platform can deliver.
 */
test('on Vercel every upload limit is capped below the 4.5 MB request ceiling', () => {
  assert.equal(platformUploadLimit(20 * 1024 * 1024, true), VERCEL_UPLOAD_CAP_BYTES);
  assert.equal(platformUploadLimit(8 * 1024 * 1024, true), VERCEL_UPLOAD_CAP_BYTES);
  assert.equal(platformUploadLimit(2 * 1024 * 1024, true), 2 * 1024 * 1024, 'a smaller configured limit is kept');
  // Room for the multipart envelope under Vercel's 4.5 MB, decimal or binary.
  assert.ok(VERCEL_UPLOAD_CAP_BYTES + 64 * 1024 < 4_500_000);
});

test('off Vercel (local development, tests) the configured limits apply unchanged', () => {
  assert.equal(platformUploadLimit(20 * 1024 * 1024, false), 20 * 1024 * 1024);
  if (!process.env.VERCEL) {
    assert.equal(env.upload.docMaxBytes, Number(process.env.UPLOAD_DOC_MAX_BYTES ?? 20 * 1024 * 1024));
  }
});

import './setup';
import { DB, SUBJECT, WRITES, resetDb } from './pageSeoTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import app from '../src/app';
import { legalDocs, REVISION_DATE } from '../src/seed/sitedata/legal';
import {
  applyLegalDocs,
  effectiveDateProblem,
  isCalendarDate,
  planLegalUpdate,
  restoreLegalDocs,
  todayInIndia,
} from '../src/scripts/lib/legalDocs';
import type { ILegalDoc } from '../src/interfaces/common';

/**
 * Policy pages (A5, 2026-10-16): the reviewed draft text, the tooling that
 * applies it to the CMS after approval, and the "Last updated" rules.
 */

const draft = (slug: string) => legalDocs.find((d) => d.slug === slug)!;
const asRow = (slug: string, extra: Record<string, unknown> = {}) => {
  const d = draft(slug);
  return {
    id: `00000000-0000-4000-a000-${String(legalDocs.indexOf(d)).padStart(12, '0')}`,
    slug: d.slug,
    title: d.title,
    meta_title: d.metaTitle,
    meta_description: d.metaDescription,
    intro: d.intro,
    sections: d.sections,
    updated: '2026-06-01',
    status: 'published',
    ...extra,
  };
};

/* ── The draft text ───────────────────────────────────────────────────────── */

const allText = (slug: string) => {
  const d = draft(slug);
  return [d.title, d.metaTitle, d.metaDescription, d.intro, ...d.sections.flatMap((s) => [s.heading, ...(s.paragraphs ?? []), ...(s.bullets ?? [])])].join('\n');
};

test('six policies, each with a Contact section, a real date and plain text only', () => {
  assert.deepEqual(legalDocs.map((d) => d.slug).sort(), ['cookie-policy', 'disclaimer', 'editorial-policy', 'privacy-policy', 'refund-policy', 'terms']);
  for (const d of legalDocs) {
    assert.ok(isCalendarDate(d.updated), `${d.slug} date`);
    assert.ok(d.updated <= todayInIndia(), `${d.slug} must not be dated in the future`);
    assert.equal(d.sections.at(-1)?.heading, 'Contact Us', `${d.slug} ends with Contact Us`);
    assert.doesNotMatch(allText(d.slug), /<[a-z!/][^>]*>/i, `${d.slug} must be plain text, not HTML`);
    assert.ok(d.metaDescription.length >= 70 && d.metaDescription.length <= 160, `${d.slug} meta description length ${d.metaDescription.length}`);
    for (const s of d.sections) assert.ok(s.heading.trim(), `${d.slug} has an empty heading`);
  }
  assert.equal(REVISION_DATE, '2026-10-16');
});

test('the draft describes the tracking that actually runs, and no consent banner', () => {
  const privacy = allText('privacy-policy');
  const cookies = allText('cookie-policy');
  for (const text of [privacy, cookies]) {
    assert.match(text, /Google Analytics/);
    // Clarity is set up in GTM but the site's CSP blocks its script, so it never
    // runs; the site's legalPolicies.test.ts checks this against next.config.mjs.
    assert.doesNotMatch(text, /Clarity|Microsoft/);
    // The old text promised a banner and Consent Mode v2; this site has neither
    // (the legacy site on the domain does). If decision D1 restores the banner,
    // rewrite the consent paragraphs and these assertions together.
    assert.doesNotMatch(text, /Consent Mode|until you accept|click(ing)? "?Accept/i);
  }
  assert.match(cookies, /does not currently show a cookie banner/);
  assert.match(cookies, /_ga\b/);
  assert.match(privacy, /Each answer is saved as you give it/);
  assert.match(privacy, /outside India/);
});

test('no invented refund rules, fee options or outcome claims', () => {
  const refund = allText('refund-policy');
  assert.doesNotMatch(refund, /\d+\s*(?:[–-]\s*\d+\s*)?(?:business |working )?days/i, 'no refund timeline until approved');
  assert.doesNotMatch(refund, /non-refundable|pro-rata|one-time transfer/i, 'no unapproved refund rules');
  assert.doesNotMatch(allText('terms'), /\bEMI\b/, 'EMI availability is unconfirmed');
  assert.doesNotMatch(allText('disclaimer'), /many learners|placement rate of|\d+\s*%/i);
  assert.doesNotMatch(allText('editorial-policy'), /trainers and mentors who work/i, 'authorship must match the GloryTecks Team byline');
});

/* ── Planning ─────────────────────────────────────────────────────────────── */

test('the plan ignores jsonb key order and reports exactly what differs', () => {
  const d = draft('disclaimer');
  const reordered = d.sections.map((s) => Object.fromEntries(Object.entries(s).reverse()));
  const live = [{ ...d, id: 'x', sections: reordered } as unknown as ILegalDoc];
  assert.equal(planLegalUpdate(live, [d])[0].action, 'unchanged');

  const changed = [{ ...d, id: 'x', intro: 'Old intro' } as unknown as ILegalDoc];
  assert.deepEqual(planLegalUpdate(changed, [d])[0].changed, ['intro']);
  assert.equal(planLegalUpdate([], [d])[0].action, 'missing');
});

test('the effective date must be real, not before today and not before the live date', () => {
  const plans = [{ slug: 'terms', action: 'update' as const, changed: ['intro'], headingsBefore: [], headingsAfter: [], currentUpdated: '2026-06-01' }];
  assert.match(effectiveDateProblem(undefined, plans, '2026-10-16') ?? '', /required/);
  assert.match(effectiveDateProblem('2026-02-30', plans, '2026-10-16') ?? '', /not a real/);
  assert.match(effectiveDateProblem('16/10/2026', plans, '2026-10-16') ?? '', /not a real/);
  assert.match(effectiveDateProblem('2026-10-15', plans, '2026-10-16') ?? '', /earlier than today/);
  assert.equal(effectiveDateProblem('2026-10-16', plans, '2026-10-16'), null);
  const later = [{ ...plans[0], currentUpdated: '2026-12-01' }];
  assert.match(effectiveDateProblem('2026-11-01', later, '2026-10-16') ?? '', /earlier than the date terms already shows/);
});

/* ── Applying (in-memory database) ────────────────────────────────────────── */

test('apply writes only the changed policies, dated with the effective date', async () => {
  resetDb({
    legal_docs: [
      asRow('privacy-policy', { intro: 'Old privacy intro', meta_description: 'Old description' }),
      asRow('terms'),
    ],
  });
  const results = await applyLegalDocs({ drafts: [draft('privacy-policy'), draft('terms')], effectiveDate: '2026-10-20' });
  assert.deepEqual(results, [
    { slug: 'privacy-policy', written: true },
    { slug: 'terms', written: false },
  ]);
  const privacy = DB.legal_docs.find((r) => r.slug === 'privacy-policy')!;
  assert.equal(privacy.intro, draft('privacy-policy').intro);
  assert.equal(privacy.updated, '2026-10-20');
  assert.equal(privacy.status, 'published', 'status is never changed');
  assert.equal(DB.legal_docs.find((r) => r.slug === 'terms')!.updated, '2026-06-01', 'an unchanged policy keeps its date');
  const writes = WRITES.filter((w) => w.table === 'legal_docs');
  assert.equal(writes.length, 1);
  assert.ok(!('slug' in (writes[0].body as object)), 'slug is never written');
  assert.deepEqual(DB.seo_audit_log.at(-1)?.changed_fields, ['metaDescription']);
  assert.equal(DB.seo_audit_log.at(-1)?.entity_key, '/privacy-policy');
});

test('restore puts back the exported text with its own original date', async () => {
  resetDb({ legal_docs: [asRow('refund-policy', { updated: '2026-10-20' })] });
  const exported = [{ ...draft('refund-policy'), intro: 'Previous intro', updated: '2026-06-01', id: 'x', status: 'published' } as unknown as ILegalDoc];
  const results = await restoreLegalDocs(exported);
  assert.deepEqual(results, [{ slug: 'refund-policy', written: true }]);
  assert.equal(DB.legal_docs[0].intro, 'Previous intro');
  assert.equal(DB.legal_docs[0].updated, '2026-06-01');
});

/* ── Admin writes: the "Last updated" field ───────────────────────────────── */

test('the CMS accepts only a real calendar date (or nothing) as "Last updated"', async () => {
  resetDb({ legal_docs: [asRow('terms')] });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = jwt.sign({ sub: SUBJECT.admin, aud: 'authenticated' }, process.env.SUPABASE_JWT_SECRET as string);
  const put = (updated: unknown) =>
    fetch(`${base}/api/v1/legal/${DB.legal_docs[0].id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ updated }),
    }).then((r) => r.status);
  try {
    for (const bad of ['Oct 3', '03/10/2026', '2026-02-30', '2026-10-16T00:00:00Z', 42]) {
      assert.equal(await put(bad), 422, String(bad));
    }
    assert.equal(await put('2026-10-16'), 200);
    assert.equal(DB.legal_docs[0].updated, '2026-10-16');
    assert.equal(await put(''), 200, 'empty shows no date');
  } finally {
    server.close();
  }
});

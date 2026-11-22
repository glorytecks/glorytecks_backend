import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBlocks } from '../src/validators/blocks.validator';
import { blocksToHtml, type Block } from '../src/utils/blocks';
import { contentSha256 } from '../src/scripts/lib/blogRewrite';
import { gateArticle, strayTrailingNumber, type GateFile, type GateLiveRow } from '../src/scripts/lib/blogGate';

/**
 * The gate is the last check before a database write. Every refusal it makes
 * is pinned here, against one article that passes.
 */

const original: Block[] = [{ type: 'paragraph', text: 'Old template body.' }];
const content: Block[] = [
  { type: 'heading', id: 'what', text: 'What it is' },
  {
    type: 'paragraph',
    text: 'A rewritten body citing [the docs](https://docs.example.org/a) and [the spec](https://docs.example.org/b), linking [a related guide](/blog/related-guide) and [the course](/courses/data-science).',
  },
];

const good = (over: Partial<GateFile> = {}): GateFile => ({
  id: 'id-1',
  slug: 'post',
  changes: {
    content,
    excerpt: 'An excerpt that is comfortably longer than seventy characters so it passes the range check.',
    metaTitle: 'A Focused Search Title for This Post',
    metaDescription: 'A meta description long enough to sit in the recommended range for search result snippets.',
    ogTitle: 'A Focused Search Title for This Post',
    ogDescription: 'A meta description long enough to sit in the recommended range for search result snippets.',
    authorKey: 'glorytecks-team',
  },
  sources: [
    { url: 'https://docs.example.org/a', supports: 'claim A', check: { status: 200, at: 'now' } },
    { url: 'https://docs.example.org/b', supports: 'claim B', check: { status: 200, at: 'now' } },
  ],
  codeVerification: [],
  review: {
    automated: {
      result: 'pass',
      failures: [],
      contentSha256: contentSha256(content),
      similarityToOriginal: 0,
      maxSimilarityToCorpus: 0.001,
      maxSimilarityToOtherRewrites: 0.001,
      templateSentences: 0,
      brokenLinks: [],
      keywordDensityPer100Words: 0.2,
    },
    independent: { verdict: 'pass' },
  },
  ...over,
});

const live = (over: Partial<GateLiveRow> = {}): GateLiveRow => ({
  id: 'id-1',
  slug: 'post',
  title: 'The Post Title',
  category_slug: 'data-science',
  date: '2026-01-01',
  author_key: 'ravi-kumar',
  seo_canonical_url: null,
  seo_noindex: false,
  contentSha256: contentSha256(original),
  ...over,
});

const ctx = {
  sha: contentSha256,
  validateBlocks,
  renderHtml: (b: Block[]) => blocksToHtml(b),
  organizationAuthorKeys: ['glorytecks-team'],
  liveSlugs: new Set(['related-guide']),
  staticPaths: new Set(['/courses/data-science']),
  baselineSha: contentSha256(original),
};

const failures = (file: GateFile, row = live()) => {
  const r = gateArticle(file, row, ctx);
  return [...r.quality.failures, ...r.metadata.failures].join(' | ');
};

test('a complete, sourced, validated rewrite under the organization byline passes', () => {
  const r = gateArticle(good(), live(), ctx);
  assert.deepEqual(r.quality.failures, []);
  assert.deepEqual(r.metadata.failures, []);
});

test('identity, URL, category and publication date can never change', () => {
  assert.match(failures(good(), live({ slug: 'other' })), /slug mismatch/);
  assert.match(failures(good(), live({ id: 'other' })), /id mismatch/);
  for (const key of ['slug', 'categorySlug', 'date', 'canonicalUrl', 'noindex']) {
    assert.match(failures(good({ changes: { ...good().changes, [key]: 'x' } })), new RegExp(`may not change ${key}`));
  }
});

test('the old text, a changed live row, or stale checks block the write', () => {
  assert.match(failures(good(), live({ contentSha256: contentSha256(content) })), /identical to the live content/);
  // Same body with corrected SEO metadata is a legitimate metadata-only write.
  assert.doesNotMatch(failures(good(), live({ contentSha256: contentSha256(content), metadataChanged: true })), /identical|changed since/);
  assert.match(failures(good(), live({ contentSha256: 'edited-later' })), /changed since the rewrite/);
  const stale = good();
  stale.review!.automated!.contentSha256 = 'old';
  assert.match(failures(stale), /stale/);
});

test('duplication, template text, stuffing and fabricated claims block the write', () => {
  const dup = good();
  dup.review!.automated!.maxSimilarityToCorpus = 0.5;
  assert.match(failures(dup), /too close to another article/);
  const stuffed = good();
  stuffed.review!.automated!.keywordDensityPer100Words = 3;
  assert.match(failures(stuffed), /keyword stuffing/);
  const claims = good({ changes: { ...good().changes, content: [...content, { type: 'paragraph', text: 'Our students earn ₹12 LPA and 500+ hiring partners call us.' }] } });
  assert.match(failures(claims), /forbidden phrasing/);
});

test('sources must resolve and be cited; internal links must point at live pages', () => {
  const dead = good();
  dead.sources![0].check = { status: 404, at: 'now' };
  assert.match(failures(dead), /did not resolve \(404\)/);
  const manual = good();
  manual.sources![0].check = { status: 403, at: 'now', manual: 'Read in a browser; blocks scripts.' };
  assert.doesNotMatch(failures(manual), /did not resolve/);
  const uncited = good({ sources: [...good().sources!, { url: 'https://docs.example.org/c', supports: 'x', check: { status: 200, at: 'now' } }] });
  assert.match(failures(uncited), /never cited/);
  assert.match(failures(good({ changes: { ...good().changes, content: [{ type: 'paragraph', text: 'See [gone](/blog/deleted-post) and [x](/courses/data-science) with [a](https://docs.example.org/a) [b](https://docs.example.org/b).' }] } })), /missing or unpublished article/);
});

test('unverified code cannot be presented as verified', () => {
  const withCode = good({ changes: { ...good().changes, content: [...content, { type: 'code', lang: 'python', code: 'print(1)' }] } });
  assert.match(failures(withCode), /without a verification record/);
  assert.match(failures({ ...withCode, codeVerification: [{ block: 'print', status: 'not executed' }] }), /not executed/);
  const claim = good({
    changes: { ...good().changes, content: [...content, { type: 'paragraph', text: 'Every example here was tested.' }, { type: 'code', lang: 'json', code: '{}' }] },
    codeVerification: [{ block: 'config', status: 'documented' }],
  });
  assert.match(failures(claim), /claims execution/);
});

test('a named person needs a recorded approval; the organization byline does not', () => {
  assert.match(failures(good({ changes: { ...good().changes, authorKey: undefined } })), /person with no recorded approval/);
  const approved = good({ changes: { ...good().changes, authorKey: 'ravi-kumar' }, byline: { authorKey: 'ravi-kumar', approvedBy: 'Ravi Kumar', approvedAt: '2026-09-24' } });
  assert.doesNotMatch(failures(approved), /approval/);
});

test('metadata ranges, promotional wording, canonical and noindex are enforced', () => {
  assert.match(failures(good({ changes: { ...good().changes, metaTitle: 'Short' } })), /SEO title is 5 characters/);
  assert.match(failures(good({ changes: { ...good().changes, metaDescription: 'The best, guaranteed course in town with a description long enough to pass the range check.' } })), /promotional/);
  assert.match(failures(good(), live({ seo_canonical_url: 'https://elsewhere.example/x' })), /canonical points elsewhere/);
  assert.match(failures(good(), live({ seo_noindex: true })), /noindex/);
});

test('markers inside code spans are code; stray markers in prose are still caught', () => {
  const extra = (text: string) => good({ changes: { ...good().changes, content: [...content, { type: 'paragraph', text }] } });
  assert.doesNotMatch(failures(extra('Collect keywords with `**kwargs` and options with `**options`.')), /unrendered Markdown/);
  assert.match(failures(extra('This **never closes and stays raw.')), /unrendered Markdown/);
  // The site renders a bold or link token's inner text as plain text.
  assert.match(failures(extra('**`LIMIT` does not reduce the data read** on its own.')), /nested inside bold or link text/);
  assert.match(failures(extra('Use the [`secrets` module](https://docs.example.org/a) instead.')), /nested inside bold or link text/);
  assert.doesNotMatch(failures(extra('See [PEP 692: precise **kwargs typing](https://docs.example.org/a).')), /nested/);
  const table = good({ changes: { ...good().changes, content: [...content, { type: 'table', head: ['a', 'b', 'c'], rows: [['1', '2', '3'], ['4', '5']] }] } });
  assert.match(failures(table), /table row width differs/);
  // Headings and FAQ questions are plain text on the site.
  const heading = (text: string) => good({ changes: { ...good().changes, content: [...content, { type: 'subheading', id: 'q', text }] } });
  assert.match(failures(heading('4. Why does `WHERE city = NULL` return nothing?')), /markup in a heading/);
  assert.doesNotMatch(failures(heading('The danger: **kwargs swallows typos')), /markup in a heading/);
});

test('"best practices" is not promotional; a rewritten title that claims "best" is', () => {
  assert.doesNotMatch(failures(good(), live({ title: 'Amazon S3 Explained: Storage, Classes and Best Practices' })), /promotional/);
  assert.doesNotMatch(failures(good({ changes: { ...good().changes, metaTitle: 'S3 Storage Best Practices for Data Lakes' } })), /promotional/);
  assert.match(failures(good({ changes: { ...good().changes, title: 'The Best Data Course in Hyderabad' } })), /title uses promotional wording/);
  // An unchanged H1 is not judged: the rewrite did not write it.
  assert.doesNotMatch(failures(good(), live({ title: 'Best Free Datasets for Data Science Practice in 2026' })), /promotional/);
});

test('the stray trailing number is caught, and legitimate numbers are not', () => {
  assert.equal(strayTrailingNumber('Mock Interview Guide: Practising Out Loud the Right Way 10', 'mock-interview-guide-practising-out-loud-the-right-way'), '10');
  assert.equal(strayTrailingNumber('Python Tips Part 2', 'python-tips-part-2'), null);
  assert.equal(strayTrailingNumber('Data Engineer Salary in Hyderabad 2026', 'data-engineer-salary-in-hyderabad-2026'), null);
  assert.equal(strayTrailingNumber('Python 3.14 Release Notes', 'python-3-14-release-notes'), null);
  assert.match(failures(good(), live({ title: 'The Post Title 10' })), /stray number "10"/);
  assert.doesNotMatch(failures(good({ changes: { ...good().changes, title: 'The Post Title' } }), live({ title: 'The Post Title 10' })), /stray/);
});

import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { neighboursOf, rankRelated, type PoolPost } from '../src/lib/blogContext';

/**
 * Post context (GET /public/blogs/:slug/context). Before 17-11-2026, prev/next
 * were "nearest date before / after", and 521 of 643 posts share one date, so
 * none of those posts linked to each other; related posts came only from the
 * 12 newest in the category.
 */

const post = (slug: string, tags: string[] = []): PoolPost => ({ slug, title: slug.toUpperCase(), tags });

// Newest first, as the repository returns it (date, then id).
const pool = [post('n1', ['a']), post('same-1', ['a', 'b']), post('same-2', ['b']), post('same-3', ['c']), post('old', ['a', 'b'])];

test('neighbours follow the pool order, so posts sharing a date still link to each other', () => {
  assert.deepEqual(neighboursOf(pool, 'same-2'), {
    prev: { slug: 'same-3', title: 'SAME-3' },
    next: { slug: 'same-1', title: 'SAME-1' },
  });
});

test('the newest post has no next and the oldest no prev', () => {
  assert.equal(neighboursOf(pool, 'n1').next, null);
  assert.deepEqual(neighboursOf(pool, 'n1').prev, { slug: 'same-1', title: 'SAME-1' });
  assert.equal(neighboursOf(pool, 'old').prev, null);
});

test('a post missing from the pool gets no neighbours rather than wrong ones', () => {
  assert.deepEqual(neighboursOf(pool, 'ghost'), { prev: null, next: null });
});

test('related posts rank by shared tags and never include the post itself', () => {
  const ranked = rankRelated({ slug: 'same-1', tags: ['a', 'B'] }, pool, 3);
  assert.equal(ranked.includes('same-1'), false);
  assert.equal(ranked[0], 'old'); // shares a and b
  assert.deepEqual(new Set(ranked.slice(1)), new Set(['n1', 'same-2'])); // one shared tag each
});

test('equal scores are spread per post but stable for the same post', () => {
  const many = Array.from({ length: 60 }, (_, i) => post(`p${i}`));
  const firstPicks = new Set(many.map((p) => rankRelated(p, many, 3)[0]));
  // Without spreading, every post would recommend the same newest posts.
  assert.ok(firstPicks.size > 20, `only ${firstPicks.size} distinct first picks`);
  assert.deepEqual(rankRelated(many[5], many, 3), rankRelated(many[5], many, 3));
});

test('every post in a category can be recommended, not only the 12 newest', () => {
  const many = Array.from({ length: 60 }, (_, i) => post(`p${i}`));
  const recommended = new Set(many.flatMap((p) => rankRelated(p, many, 3)));
  assert.ok(recommended.size > 45, `only ${recommended.size} of 60 posts are ever recommended`);
});

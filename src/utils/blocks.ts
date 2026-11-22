/**
 * Blog content engine — ported verbatim from the public website's
 * `src/data/blog/content.ts` so the CMS produces byte-for-byte the same HTML,
 * table of contents, FAQ extraction and read-time estimate the site already
 * relies on. Do not diverge from the website implementation.
 */

export type Block =
  | { type: 'heading'; id: string; text: string }
  | { type: 'subheading'; id: string; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered?: boolean; items: string[] }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'code'; lang: string; code: string }
  | { type: 'callout'; variant: 'info' | 'tip' | 'warning' | 'success'; title?: string; text: string }
  | { type: 'quote'; text: string; cite?: string }
  | { type: 'image'; url: string; alt?: string; caption?: string }
  | { type: 'faq'; items: { q: string; a: string }[] };

export type TocItem = { id: string; text: string };
export type FaqItem = { q: string; a: string };

/** URL-safe slug (matches the site's slugify). */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Ensure heading/subheading blocks always carry a stable id. */
export function normalizeBlocks(blocks: Block[]): Block[] {
  return blocks.map((b) => {
    if (b.type === 'heading' || b.type === 'subheading') {
      return { ...b, id: b.id && b.id.trim() ? b.id : slugify(b.text) };
    }
    return b;
  });
}

export function escapeHtml(s = ''): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Schemes safe to emit into an `href`/`src` in published blog HTML.
 *
 * Block content is author-supplied and the rendered `blogs.html` is served to
 * anonymous visitors by the public API, so a `javascript:` or
 * `data:text/html` URL here is stored XSS on the marketing site. Anything not
 * recognisably a web link is replaced rather than rejected: an author should
 * not be able to break a published page, and a dead link is a better failure
 * than an executable one.
 */
const SAFE_URL = /^(https?:\/\/|\/(?!\/)|#|mailto:|tel:)/i;

export function safeUrl(raw: string | undefined, fallback = '#'): string {
  const value = String(raw ?? '').trim();
  if (!value) return fallback;
  // The caller escapes before interpolating, so a scheme could otherwise hide
  // behind an entity or an ignorable control character.
  const probe = value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#[0-9a-fx]+;?/gi, '')
    .replace(/[\s\u0000-\u0020\u007f-\u009f]/g, '');
  return SAFE_URL.test(probe) ? value : fallback;
}

/**
 * The three inline markers, tokenised in one left-to-right pass: **bold**,
 * `code` and [text](url). Same pattern and order as the site's renderer
 * (main-website/components/blog/BlogContent.tsx), so the stored HTML matches
 * what readers see. In particular, markers inside a code span are code:
 * `**kwargs` and `**options` in one sentence stay two code spans instead of
 * being paired into a <strong> that crosses them.
 */
export const INLINE_TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

/**
 * Text the renderers parse for inline markers: paragraphs, quotes, callouts,
 * list items, table cells and FAQ answers. Headings and FAQ questions are
 * plain text on both the site and in the stored HTML.
 */
export function inlineRenderedTexts(blocks: readonly Block[]): string[] {
  return blocks.flatMap((b) => {
    switch (b.type) {
      case 'paragraph':
      case 'quote':
      case 'callout':
        return [b.text];
      case 'list':
        return b.items;
      case 'table':
        return b.rows.flat();
      case 'faq':
        return b.items.map((i) => i.a);
      default:
        return [];
    }
  });
}

/**
 * Markers nested inside a bold or link token. The site renders a token's
 * inner text as plain text, so `code` inside **bold**, or `code` or **bold**
 * inside [link text](url), shows its backticks and asterisks to readers.
 * (A lone ** in link text, as in "**kwargs", is plain text and fine.)
 */
export function nestedMarkup(text: string): string[] {
  return (text.match(INLINE_TOKEN) ?? []).filter((tok) => {
    if (tok.startsWith('**')) return tok.slice(2, -2).includes('`') || /\[[^\]]+\]\(/.test(tok);
    if (tok.startsWith('[')) {
      const label = tok.slice(1, tok.indexOf(']('));
      return label.includes('`') || /\*\*[^*]+\*\*/.test(label);
    }
    return false;
  });
}

/**
 * Plain-text fields (headings, FAQ questions, table headers, callout titles)
 * that contain inline markers. Neither renderer parses these, so backticks or
 * a **bold** pair would be shown raw. A lone ** (as in "**kwargs") is text.
 */
export function plainTextMarkup(blocks: readonly Block[]): string[] {
  const plain = blocks.flatMap((b) => {
    switch (b.type) {
      case 'heading':
      case 'subheading':
        return [b.text];
      case 'faq':
        return b.items.map((i) => i.q);
      case 'table':
        return b.head;
      case 'callout':
        return b.title ? [b.title] : [];
      default:
        return [];
    }
  });
  return plain.filter((t) => t.includes('`') || /\*\*[^*]+\*\*/.test(t) || /\[[^\]]+\]\([^)]+\)/.test(t));
}

/** Markdown left over after the renderer's tokens are removed: it would show as raw characters. */
export function leftoverMarkup(text: string): boolean {
  return /\*\*|\]\(|```/.test(text.replace(INLINE_TOKEN, ' '));
}

/** Convert **bold**, `code` and [text](url) to HTML, escaping everything else. */
export function inlineToHtml(s: string): string {
  return s
    .split(INLINE_TOKEN)
    .map((part) => {
      if (!part) return '';
      if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return `<strong>${escapeHtml(part.slice(2, -2))}</strong>`;
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) return `<a href="${escapeHtml(safeUrl(link[2]))}">${escapeHtml(link[1])}</a>`;
      return escapeHtml(part);
    })
    .join('');
}

export function blocksToHtml(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        parts.push(`<h2 id="${escapeHtml(b.id)}">${escapeHtml(b.text)}</h2>`);
        break;
      case 'subheading':
        parts.push(`<h3 id="${escapeHtml(b.id)}">${escapeHtml(b.text)}</h3>`);
        break;
      case 'paragraph':
        parts.push(`<p>${inlineToHtml(b.text)}</p>`);
        break;
      case 'list':
        parts.push(
          `<${b.ordered ? 'ol' : 'ul'}>${b.items
            .map((i) => `<li>${inlineToHtml(i)}</li>`)
            .join('')}</${b.ordered ? 'ol' : 'ul'}>`,
        );
        break;
      case 'table':
        parts.push(
          `<table><thead><tr>${b.head
            .map((hd) => `<th>${escapeHtml(hd)}</th>`)
            .join('')}</tr></thead><tbody>${b.rows
            .map((r) => `<tr>${r.map((c) => `<td>${inlineToHtml(c)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`,
        );
        break;
      case 'code':
        parts.push(
          `<pre><code class="language-${escapeHtml(b.lang)}">${escapeHtml(b.code)}</code></pre>`,
        );
        break;
      case 'callout':
        parts.push(
          `<aside class="callout callout-${b.variant}">${
            b.title ? `<strong>${escapeHtml(b.title)}: </strong>` : ''
          }${inlineToHtml(b.text)}</aside>`,
        );
        break;
      case 'quote':
        parts.push(
          `<blockquote>${inlineToHtml(b.text)}${
            b.cite ? `<cite>${escapeHtml(b.cite)}</cite>` : ''
          }</blockquote>`,
        );
        break;
      case 'image':
        if (b.url) {
          parts.push(
            `<figure class="blog-image"><img src="${escapeHtml(safeUrl(b.url, ''))}" alt="${escapeHtml(
              b.alt ?? '',
            )}" loading="lazy" />${
              b.caption ? `<figcaption>${escapeHtml(b.caption)}</figcaption>` : ''
            }</figure>`,
          );
        }
        break;
      case 'faq':
        parts.push(
          `<section class="faq"><h2 id="faq">Frequently Asked Questions</h2>${b.items
            .map(
              (i) =>
                `<div class="faq-item"><h3>${escapeHtml(i.q)}</h3><p>${inlineToHtml(i.a)}</p></div>`,
            )
            .join('')}</section>`,
        );
        break;
      default:
        break;
    }
  }
  return parts.join('\n');
}

/** Table of contents = top-level headings (h2). */
export function tableOfContents(blocks: Block[]): TocItem[] {
  return blocks
    .filter((b): b is Extract<Block, { type: 'heading' }> => b.type === 'heading')
    .map((b) => ({ id: b.id, text: b.text }));
}

/** Collect FAQ items across blocks (for FAQPage schema). */
export function collectFaq(blocks: Block[]): FaqItem[] {
  const items: FaqItem[] = [];
  for (const b of blocks) if (b.type === 'faq') items.push(...b.items);
  return items;
}

/** Estimate read time (≈ 200 wpm + table/code overhead). Returns e.g. "8 min". */
export function estimateReadTime(blocks: Block[]): string {
  let words = 0;
  for (const b of blocks) {
    if (b.type === 'paragraph') words += b.text.split(/\s+/).length;
    else if (b.type === 'list') words += b.items.join(' ').split(/\s+/).length;
    else if (b.type === 'heading' || b.type === 'subheading') words += b.text.split(/\s+/).length;
    else if (b.type === 'callout') words += b.text.split(/\s+/).length + 6;
    else if (b.type === 'table') words += b.head.length * 3 + b.rows.flat().length * 3;
    else if (b.type === 'code') words += b.code.split(/\s+/).length;
    else if (b.type === 'faq')
      words += b.items
        .map((i) => i.q + ' ' + i.a)
        .join(' ')
        .split(/\s+/).length;
  }
  return `${Math.max(3, Math.round(words / 200))} min`;
}

/** Plain-text word count (for SEO wordCount in BlogPosting schema). */
export function wordCount(blocks: Block[]): number {
  return blocks
    .map((b) =>
      b.type === 'paragraph'
        ? b.text.split(/\s+/).length
        : b.type === 'list'
          ? b.items.join(' ').split(/\s+/).length
          : 0,
    )
    .reduce((a, c) => a + c, 0);
}

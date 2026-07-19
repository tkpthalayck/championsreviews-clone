import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// WordPress's REST API returns title/excerpt/category text with HTML
// entities left un-decoded (e.g. "Works &amp; Whether" as literal
// characters, "&#8217;" instead of a real apostrophe) - these are plain-
// text fields rendered through Astro's auto-escaping {} interpolation,
// which doesn't know about entities and just re-escapes the leading "&",
// so without this every one of these shows up broken (double-escaped or
// as literal entity text) on 292 of 295 posts' excerpts and 51 titles.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', nbsp: ' ', quot: '"', lt: '<', gt: '>', apos: "'",
};
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}
// Only genuine spelling/punctuation duplicates go here - e.g. "Health Care"
// and "Health & Nutrition" are different real categories, not aliases of
// "Health & Wellness", even though they sound related.
const CATEGORY_ALIASES: Record<string, string> = {
  'Health and Wellness': 'Health & Wellness',
};
// WordPress's default/placeholder category for uncategorized posts, not a
// real topic - filtered out rather than shown as a browsable category.
const PLACEHOLDER_CATEGORIES = new Set(['Root']);

const posts = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/posts' }),
  schema: z.object({
    id: z.number(),
    slug: z.string(),
    title: z.string().transform(decodeEntities),
    date: z.string(),
    modified: z.string(),
    excerpt: z.string().transform(decodeEntities),
    categories: z.array(z.string()).transform((cats) => cats
      .map(decodeEntities)
      .map((c) => CATEGORY_ALIASES[c] ?? c)
      .filter((c) => !PLACEHOLDER_CATEGORIES.has(c))),
    tags: z.array(z.string()).transform((tags) => tags.map(decodeEntities)),
    featuredImage: z.string().nullable(),
    body: z.string(),
  }),
});

const pages = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/pages' }),
  schema: z.object({
    id: z.number(),
    slug: z.string(),
    title: z.string().transform(decodeEntities),
    date: z.string(),
    modified: z.string(),
    body: z.string(),
  }),
});

export const collections = { posts, pages };

// Daily incremental sync: checks championsreviews.com's WordPress REST API
// (read-only GET requests only - never writes back to the live site) for
// posts/pages that are new or have a newer `modified` timestamp than what's
// already committed here, and updates only those. Unlike export-content.mjs
// (the original one-time full migration), this is designed to run
// unattended in CI every day and touch as little as possible:
//   - unchanged content is left alone (compares WP's `modified` field
//     against the value already stored in each JSON file)
//   - content intentionally excluded from the clone (non-functional WP
//     account/cart/etc. pages, one corrupted post - see README) is never
//     resurrected even if it still exists on WordPress
//   - a slug rename (same WP id, different slug) removes the stale file
//     under the old slug instead of leaving a duplicate behind
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const WP_BASE = 'https://championsreviews.com/wp-json/wp/v2';
const OUT_POSTS = path.resolve('src/content/posts');
const OUT_PAGES = path.resolve('src/content/pages');
const OUT_IMAGES = path.resolve('public/images');

// Pages removed during the initial migration because they depend on
// WooCommerce/account backend functionality GitHub Pages can't run -
// keep excluding them even if they're still live on WordPress.
const EXCLUDED_PAGE_SLUGS = new Set([
  'account', 'all-post-catalog', 'all-posts', 'blog', 'cart', 'checkout',
  'home', 'login', 'logout', 'members', 'my-account', 'password-reset',
  'register', 'shop', 'shop-internal-placeholder', 'subscribe-for-latest-updates',
  'user', 'user-login-page', 'user-sign-up-form',
]);
// A post whose body was a ~430KB corrupted paste from an unrelated React
// app, not real editorial content - see the project's final report.
const EXCLUDED_POST_SLUGS = new Set([
  'the-wonders-of-black-seed-oil-habbatus-sauda-in-islamic-tradition',
]);

async function wpFetch(endpoint) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(WP_BASE + endpoint, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`${endpoint} -> ${res.status}`);
      return await res.json();
    } catch (e) {
      console.warn(`  [retry ${attempt}] ${endpoint}: ${e.message}`);
      if (attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function wpFetchAllPages(endpoint, perPage = 20) {
  const all = [];
  let page = 1;
  let totalPages = 1;
  for (;;) {
    let res;
    let ok = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        res = await fetch(WP_BASE + endpoint + (endpoint.includes('?') ? '&' : '?') + `per_page=${perPage}&page=${page}`, {
          signal: AbortSignal.timeout(120000),
        });
        ok = true;
        break;
      } catch (e) {
        console.warn(`  [retry ${attempt}] ${endpoint} page ${page}: ${e.message}`);
        if (attempt < 5) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (!ok) {
      console.warn(`  [SKIPPING page ${page} of ${endpoint} after 5 failed attempts]`);
      page++;
      if (page > totalPages) break;
      continue;
    }
    if (res.status === 400) break;
    if (!res.ok) {
      console.warn(`  [SKIPPING page ${page} of ${endpoint}: HTTP ${res.status}]`);
      page++;
      if (page > totalPages) break;
      continue;
    }
    const batch = await res.json();
    if (!batch.length) break;
    all.push(...batch);
    totalPages = Number(res.headers.get('x-wp-totalpages') || totalPages);
    if (page >= totalPages) break;
    page++;
  }
  return all;
}

function makeLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      runNext();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    runNext();
  });
}
const imageLimit = makeLimiter(6);
const itemLimit = makeLimiter(8);

const imageCache = new Map(); // URL -> local path, dedup within this run

// Re-syncing a post re-downloads its images (there's no record of which WP
// URL a previously-committed img-N.ext came from), but hashing existing
// files' actual bytes lets a re-download recognize identical content and
// reuse the existing file instead of writing a duplicate under a new
// number - built fresh from disk each run so it can never drift out of
// sync with what's actually committed.
let hashToFilenamePromise;
async function loadExistingImageHashes() {
  const files = await fs.readdir(OUT_IMAGES).catch(() => []);
  const map = new Map();
  let maxNumber = 0;
  await Promise.all(files.map(async (f) => {
    const m = f.match(/^img-(\d+)\./);
    if (m) maxNumber = Math.max(maxNumber, Number(m[1]));
    const buf = await fs.readFile(path.join(OUT_IMAGES, f)).catch(() => null);
    if (buf) map.set(crypto.createHash('sha256').update(buf).digest('hex'), f);
  }));
  return { hashes: map, nextNumber: maxNumber + 1 };
}

async function downloadImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const pending = imageLimit(async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`image fetch ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const hash = crypto.createHash('sha256').update(buf).digest('hex');

        if (!hashToFilenamePromise) hashToFilenamePromise = loadExistingImageHashes();
        const state = await hashToFilenamePromise;

        const existing = state.hashes.get(hash);
        if (existing) return `/images/${existing}`;

        const ext = (url.split('.').pop() || 'jpg').split(/[?#]/)[0].slice(0, 5);
        const filename = `img-${state.nextNumber++}.${ext}`;
        await fs.writeFile(path.join(OUT_IMAGES, filename), buf);
        state.hashes.set(hash, filename); // so two new posts sharing an image this run dedup too
        return `/images/${filename}`;
      } catch (e) {
        if (attempt === 2) {
          console.warn('  [image failed, hotlinking instead]', url, e.message);
          return url;
        }
      }
    }
  });
  imageCache.set(url, pending);
  const result = await pending;
  imageCache.set(url, result);
  return result;
}

async function localizeImages(html) {
  const urls = new Set();
  const re = /(?:src|data-src)="(https:\/\/championsreviews\.com\/wp-content\/uploads\/[^"]+|https:\/\/m\.media-amazon\.com\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html))) urls.add(m[1]);
  const pairs = await Promise.all([...urls].map(async (url) => [url, await downloadImage(url)]));
  let out = html;
  for (const [url, local] of pairs) out = out.split(url).join(local);
  return out;
}

async function loadLocalIndex(dir) {
  const index = new Map(); // wp id -> { slug, modified, file }
  const files = await fs.readdir(dir).catch(() => []);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(dir, file);
    try {
      const data = JSON.parse(await fs.readFile(full, 'utf8'));
      if (data.id != null) index.set(data.id, { slug: data.slug, modified: data.modified, file: full });
    } catch {
      // ignore unreadable/legacy files rather than crash the whole sync
    }
  }
  return index;
}

async function syncPosts(catMap, tagMap) {
  const localIndex = await loadLocalIndex(OUT_POSTS);
  const remote = await wpFetchAllPages('/posts?_fields=id,slug,modified');
  console.log(`WordPress has ${remote.length} posts.`);

  const changed = remote.filter((p) => {
    if (EXCLUDED_POST_SLUGS.has(decodeURIComponent(p.slug))) return false;
    const local = localIndex.get(p.id);
    return !local || new Date(p.modified) > new Date(local.modified);
  });
  console.log(`${changed.length} post(s) are new or updated.`);

  const result = { new: 0, updated: 0, renamed: 0 };
  await Promise.all(changed.map((p) => itemLimit(async () => {
    const full = await wpFetch(`/posts/${p.id}?_fields=id,slug,title,content,excerpt,date,modified,categories,tags,featured_media`);
    const body = await localizeImages(full.content.rendered);
    const featuredUrl = full.featured_media
      ? (await wpFetch(`/media/${full.featured_media}?_fields=source_url`).catch(() => null))?.source_url
      : null;
    const featuredLocal = featuredUrl ? await downloadImage(featuredUrl) : null;
    const slug = decodeURIComponent(full.slug);
    const entry = {
      id: full.id,
      slug,
      title: full.title.rendered,
      date: full.date,
      modified: full.modified,
      excerpt: full.excerpt.rendered.replace(/<[^>]+>/g, '').trim(),
      categories: (full.categories || []).map((id) => catMap.get(id)).filter(Boolean),
      tags: (full.tags || []).map((id) => tagMap.get(id)).filter(Boolean),
      featuredImage: featuredLocal,
      body,
    };
    const existing = localIndex.get(full.id);
    if (existing && existing.slug !== slug) {
      await fs.unlink(existing.file).catch(() => {});
      result.renamed++;
    }
    await fs.writeFile(path.join(OUT_POSTS, `${slug}.json`), JSON.stringify(entry, null, 2));
    if (existing) result.updated++; else result.new++;
    console.log(`  synced post: ${slug}`);
  })));
  return result;
}

async function syncPages() {
  const localIndex = await loadLocalIndex(OUT_PAGES);
  const remote = await wpFetchAllPages('/pages?_fields=id,slug,modified');
  console.log(`WordPress has ${remote.length} pages.`);

  const changed = remote.filter((p) => {
    if (EXCLUDED_PAGE_SLUGS.has(decodeURIComponent(p.slug))) return false;
    const local = localIndex.get(p.id);
    return !local || new Date(p.modified) > new Date(local.modified);
  });
  console.log(`${changed.length} page(s) are new or updated.`);

  const result = { new: 0, updated: 0, renamed: 0 };
  await Promise.all(changed.map((p) => itemLimit(async () => {
    const full = await wpFetch(`/pages/${p.id}?_fields=id,slug,title,content,date,modified`);
    const body = await localizeImages(full.content.rendered);
    const slug = decodeURIComponent(full.slug);
    const entry = { id: full.id, slug, title: full.title.rendered, date: full.date, modified: full.modified, body };
    const existing = localIndex.get(full.id);
    if (existing && existing.slug !== slug) {
      await fs.unlink(existing.file).catch(() => {});
      result.renamed++;
    }
    await fs.writeFile(path.join(OUT_PAGES, `${slug}.json`), JSON.stringify(entry, null, 2));
    if (existing) result.updated++; else result.new++;
    console.log(`  synced page: ${slug}`);
  })));
  return result;
}

async function main() {
  await fs.mkdir(OUT_POSTS, { recursive: true });
  await fs.mkdir(OUT_PAGES, { recursive: true });
  await fs.mkdir(OUT_IMAGES, { recursive: true });

  console.log('Fetching categories/tags...');
  const categories = await wpFetchAllPages('/categories');
  const tags = await wpFetchAllPages('/tags');
  const catMap = new Map(categories.map((c) => [c.id, c.name]));
  const tagMap = new Map(tags.map((t) => [t.id, t.name]));

  const posts = await syncPosts(catMap, tagMap);
  const pages = await syncPages();

  console.log('\nSync summary:');
  console.log(`  posts:  ${posts.new} new, ${posts.updated} updated, ${posts.renamed} renamed`);
  console.log(`  pages:  ${pages.new} new, ${pages.updated} updated, ${pages.renamed} renamed`);
  console.log(`  images: ${imageCache.size} downloaded/reused this run`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

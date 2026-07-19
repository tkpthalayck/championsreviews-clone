// One-time content export: pulls all posts + pages from the live WordPress
// site via its REST API (read-only GET requests only - this script never
// writes anything back to championsreviews.com) and converts them into
// Astro data-collection JSON entries, downloading every image actually
// referenced in post content (not a blanket dump of the whole 1730-item
// media library, most of which is unused/orphaned).
//
// The raw WP metadata fetch (categories/tags/posts/pages/media map) is slow
// on this host (~5-15s per request) so it's cached to disk after the first
// successful run - re-running this script to retune image handling doesn't
// need to re-fetch everything from the live site. Delete scripts/.cache/
// to force a full refetch.
import fs from 'node:fs/promises';
import path from 'node:path';

const WP_BASE = 'https://championsreviews.com/wp-json/wp/v2';
const OUT_POSTS = path.resolve('src/content/posts');
const OUT_PAGES = path.resolve('src/content/pages');
const OUT_IMAGES = path.resolve('public/images');
const CACHE_FILE = path.resolve('scripts/.cache/raw-export.json');

async function wpFetch(endpoint) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(WP_BASE + endpoint, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`${endpoint} -> ${res.status}`);
      return res.json();
    } catch (e) {
      console.warn(`  [retry ${attempt}] ${endpoint}: ${e.message}`);
      if (attempt === 3) throw e;
    }
  }
}

async function wpFetchAllPages(endpoint, perPage = 10) {
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
      console.warn(`  [SKIPPING page ${page} of ${endpoint} after 5 failed attempts - some content will be missing]`);
      page++;
      if (page > totalPages) break;
      continue;
    }
    if (res.status === 400) break; // past last page
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
    console.log(`  ...fetched page ${page}/${totalPages} of ${endpoint.split('?')[0]} (${all.length} so far)`);
    if (page >= totalPages) break;
    page++;
  }
  return all;
}

// Simple concurrency-limited map, no external dependency needed.
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
// This host takes ~5-15s per request even for a single isolated file, so a
// short timeout guarantees false failures - what looked like "the site is
// blocking us" was actually just a too-aggressive timeout. Moderate
// concurrency still helps since the wait is I/O-bound, not CPU-bound.
const imageLimit = makeLimiter(6);
const postLimit = makeLimiter(8);

const imageCache = new Map(); // original URL -> local path (dedup across posts)
let imageCounter = 0;

async function downloadImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const pending = imageLimit(async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`image fetch ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const ext = (url.split('.').pop() || 'jpg').split(/[?#]/)[0].slice(0, 5);
        imageCounter++;
        const filename = `img-${imageCounter}.${ext}`;
        await fs.writeFile(path.join(OUT_IMAGES, filename), buf);
        return `/images/${filename}`;
      } catch (e) {
        if (attempt === 2) {
          console.warn('  [image failed, hotlinking instead]', url, e.message);
          return url; // fall back to hotlinking rather than a broken image
        }
      }
    }
  });
  imageCache.set(url, pending);
  const result = await pending;
  imageCache.set(url, result); // replace the in-flight promise with the resolved value
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

async function fetchRawData() {
  try {
    const cached = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
    console.log(`Using cached WP metadata from ${CACHE_FILE} (delete this file to force a refetch).`);
    return cached;
  } catch {
    // no cache yet, fetch fresh below
  }

  console.log('Fetching categories/tags...');
  const categories = await wpFetchAllPages('/categories');
  const tags = await wpFetchAllPages('/tags');

  console.log('Fetching all posts...');
  const posts = await wpFetchAllPages('/posts?_fields=id,slug,title,content,excerpt,date,modified,categories,tags,featured_media');
  console.log(`Got ${posts.length} posts.`);

  console.log('Fetching media map for featured images...');
  const mediaMap = {};
  const mediaIds = [...new Set(posts.map((p) => p.featured_media).filter(Boolean))];
  for (let i = 0; i < mediaIds.length; i += 20) {
    const chunk = mediaIds.slice(i, i + 20);
    const batch = await wpFetch(`/media?include=${chunk.join(',')}&per_page=100&_fields=id,source_url`);
    for (const m of batch) mediaMap[m.id] = m.source_url;
  }

  console.log('Fetching all pages...');
  const pages = await wpFetchAllPages('/pages?_fields=id,slug,title,content,date,modified');

  const raw = { categories, tags, posts, mediaMap, pages };
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(raw));
  console.log(`Cached raw WP data to ${CACHE_FILE}.`);
  return raw;
}

async function main() {
  await fs.mkdir(OUT_POSTS, { recursive: true });
  await fs.mkdir(OUT_PAGES, { recursive: true });
  await fs.mkdir(OUT_IMAGES, { recursive: true });

  const { categories, tags, posts, mediaMap, pages } = await fetchRawData();
  const catMap = new Map(categories.map((c) => [c.id, c.name]));
  const tagMap = new Map(tags.map((t) => [t.id, t.name]));

  let done = 0;
  await Promise.all(posts.map((p) => postLimit(async () => {
    const body = await localizeImages(p.content.rendered);
    const featuredUrl = p.featured_media ? mediaMap[p.featured_media] : null;
    const featuredLocal = featuredUrl ? await downloadImage(featuredUrl) : null;
    // WordPress URL-encodes slugs for titles starting with non-ASCII
    // characters (emoji); decode so Astro's route matching (which decodes
    // the request path before matching params) works during build.
    const slug = decodeURIComponent(p.slug);
    const entry = {
      id: p.id,
      slug,
      title: p.title.rendered,
      date: p.date,
      modified: p.modified,
      excerpt: p.excerpt.rendered.replace(/<[^>]+>/g, '').trim(),
      categories: (p.categories || []).map((id) => catMap.get(id)).filter(Boolean),
      tags: (p.tags || []).map((id) => tagMap.get(id)).filter(Boolean),
      featuredImage: featuredLocal,
      body,
    };
    await fs.writeFile(path.join(OUT_POSTS, `${slug}.json`), JSON.stringify(entry, null, 2));
    done++;
    if (done % 25 === 0) console.log(`  ...${done}/${posts.length} posts done`);
  })));
  console.log(`Posts done: ${done}`);

  await Promise.all(pages.map((p) => postLimit(async () => {
    const body = await localizeImages(p.content.rendered);
    const slug = decodeURIComponent(p.slug);
    const entry = { id: p.id, slug, title: p.title.rendered, date: p.date, modified: p.modified, body };
    await fs.writeFile(path.join(OUT_PAGES, `${slug}.json`), JSON.stringify(entry, null, 2));
  })));
  console.log(`Pages done: ${pages.length}`);
  console.log(`Unique images referenced: ${imageCache.size}`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

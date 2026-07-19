import { parseFragment, serialize, defaultTreeAdapter } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const PUBLIC_DIR = path.resolve('public');
// Persists for the lifetime of the build process (all pages build in one
// Node process), so the same locally-downloaded image referenced from
// multiple posts only gets decoded once.
const dimensionCache = new Map<string, { width: number; height: number } | null>();

async function getImageDimensions(localPath: string) {
  if (dimensionCache.has(localPath)) return dimensionCache.get(localPath)!;
  let result: { width: number; height: number } | null = null;
  try {
    const buf = await fs.readFile(path.join(PUBLIC_DIR, localPath));
    const meta = await sharp(buf).metadata();
    if (meta.width && meta.height) result = { width: meta.width, height: meta.height };
  } catch {
    // leave as null - a missing/unreadable file isn't this function's problem to fix
  }
  dimensionCache.set(localPath, result);
  return result;
}

// Astro's import.meta.env.BASE_URL does not reliably carry a trailing
// slash across versions/configs, so every `${base}segment/`-style
// concatenation throughout the site risked producing malformed URLs like
// "/championsreviews-clonereviews/" (missing separator). Normalize once,
// here, and have every page/component import this instead of reading
// BASE_URL directly.
export const BASE = import.meta.env.BASE_URL.replace(/\/?$/, '/');

// WordPress post/page body HTML embeds root-relative URLs - locally
// downloaded images ("/images/img-N.jpg") and internal cross-links to other
// WP pages (e.g. "/privacy-policy") - with no knowledge of Astro's
// deploy-time base path. Rewrite any single-leading-slash token (in
// src/href/srcset) to carry the base prefix. Protocol-relative ("//host")
// and already-absolute ("https://...", used as a fallback when an image
// failed to download) URLs are left untouched, including inside
// multi-source srcset lists.
export function localizeBody(body: string): string {
  return body.replace(
    /((?:src|href|srcset)=")([^"]*)"/g,
    (_match, attr: string, value: string) =>
      `${attr}${value
        .split(',')
        .map((part) => part.replace(/^(\s*)\/(?!\/)/, `$1${BASE}`))
        .join(',')}"`,
  );
}

type Node = DefaultTreeAdapterMap['node'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type Element = DefaultTreeAdapterMap['element'];

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

// Text nodes can be nested inside child elements (e.g. <h2><strong>Title</strong></h2>),
// so checking a heading's own childNodes for a single text node isn't enough
// to tell whether it's genuinely empty.
function getTextContent(node: Node): string {
  if (defaultTreeAdapter.isTextNode(node)) return defaultTreeAdapter.getTextNodeContent(node);
  const children = defaultTreeAdapter.getChildNodes(node as ParentNode) ?? [];
  return children.map(getTextContent).join('');
}

// A handful of WordPress posts contain markup that's malformed against the
// HTML5 spec: <style> blocks placed as arbitrary descendants (only valid in
// <head> or as body's first child), unclosed <p> tags (legacy wpautop
// output), and - in one post - an entire second <!doctype html>...</html>
// document pasted into the content editor. Re-parsing the fragment through
// parse5 (the same tree-construction algorithm browsers use) auto-closes
// implicit tags exactly as a browser would, and lets us pull out the parts
// that don't belong in a content fragment (style/meta/title left over from
// the pasted document) instead of guessing at them with regex.
// Ids already used by the page's own chrome (Header/BaseLayout render
// outside this fragment, so the parser can't see them) - seeded as
// "already taken" so a colliding id from pasted content gets renamed
// instead of silently shadowing the real one.
const RESERVED_IDS = ['main', 'mobile-menu', 'mobile-menu-btn', 'back-to-top', 'hero-search'];

// Not valid HTML attributes anywhere - one post's content was pasted from
// a rich-text editor (ProseMirror/Notion-style, judging by the surrounding
// data-node-view-wrapper/data-testid markup) that leaked its internal DOM
// attributes into the exported HTML. "frameborder" is obsolete HTML4 iframe
// cruft. "onclick"/"tabindex"/ARIA widget-state attributes (aria-expanded,
// aria-controls) describe JS-driven behavior (toggles, lightboxes) this
// static site never ships the JS for - leaving them is a false promise to
// assistive tech, worse than having no ARIA at all.
const STRIP_ATTRS_GLOBAL = new Set([
  'as', 'level', 'hex', 'indent', 'frameborder',
  'onclick', 'tabindex', 'aria-expanded', 'aria-controls',
]);
// Obsolete only on <table> - "width"/"border" are still valid on <img>,
// which uses them legitimately throughout this content.
const STRIP_ATTRS_TABLE = new Set(['cellpadding', 'cellspacing', 'width', 'border']);

export async function sanitizeBody(rawBody: string): Promise<{ html: string; styles: string }> {
  const fragment = parseFragment(rawBody, { scriptingEnabled: false });
  const styles: string[] = [];
  const activeId = new Map<string, string>(RESERVED_IDS.map((id) => [id, id]));
  const idOccurrences = new Map<string, number>(RESERVED_IDS.map((id) => [id, 1]));
  const imagesNeedingDimensions: Element[] = [];

  const headings = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

  function walk(parent: ParentNode) {
    const parentTag = isElement(parent as Node) ? (parent as Element).tagName : undefined;
    const children = defaultTreeAdapter.getChildNodes(parent) ?? [];
    for (const child of [...children]) {
      if (!isElement(child)) continue;

      // <style>/<meta>/<title>/<base> are only valid in <head>, or - a few
      // WordPress posts have an entire second HTML document pasted into
      // their content - are leftovers from that document's own <head>.
      if (child.tagName === 'style') {
        styles.push(defaultTreeAdapter.getTextNodeContent(child.childNodes[0] as any) ?? '');
        defaultTreeAdapter.detachNode(child);
        continue;
      }
      if (child.tagName === 'meta' || child.tagName === 'title' || child.tagName === 'base') {
        defaultTreeAdapter.detachNode(child);
        continue;
      }
      // <main> is a page-level landmark that must appear at most once per
      // document; the real one is BaseLayout's. A few posts use <main> as
      // a generic wrapper div for a product grid - keep the markup, drop
      // the landmark semantics.
      if (child.tagName === 'main') {
        child.tagName = 'div';
        child.nodeName = 'div';
      }
      // Same idea for <h1>: the page template already renders one from the
      // post's title (BaseLayout/[slug].astro), so a second one inside the
      // body - left over from whichever of the ~5 different content
      // pipelines authored that post - is a duplicate top-level heading,
      // not a deliberate structural choice worth preserving as-is.
      if (child.tagName === 'h1') {
        child.tagName = 'h2';
        child.nodeName = 'h2';
      }
      // An empty heading (some posts have literal <h1 class="wp-block-heading"></h1>)
      // gives a screen-reader user navigating by heading list a stop with
      // nothing to announce - worse than not being a heading landmark at all.
      if (headings.has(child.tagName) && !getTextContent(child).trim()) {
        defaultTreeAdapter.detachNode(child);
        continue;
      }
      // Headings only permit phrasing content. A few product-widget posts
      // decorate a heading with a purely cosmetic <div class="section-line">
      // underline - <span> renders identically here (this content never had
      // the original WordPress theme's CSS carried over, so neither tag was
      // producing a visible block-level line anyway) and is valid inline.
      if (child.tagName === 'div' && parentTag && headings.has(parentTag)) {
        child.tagName = 'span';
        child.nodeName = 'span';
      }
      // role="button" is the same kind of dead widget-state marker as the
      // attributes above, but its value matters (other roles, e.g.
      // "presentation", are still meaningful without JS) so it's filtered
      // by value rather than stripped by name.
      child.attrs = child.attrs.filter((attr) => !(attr.name === 'role' && attr.value === 'button'));

      // An empty href is worse than no attribute at all - satisfies the
      // "must be non-empty" rule (an <a> without href gets turned into a
      // <span> below anyway).
      child.attrs = child.attrs.filter((attr) => !(attr.name === 'href' && attr.value === ''));
      // Unlike href, <img> requires a src to be present at all, so an
      // empty one is repointed at the site's fallback image instead of
      // being dropped (seen on a dead JS-lightbox placeholder image).
      if (child.tagName === 'img') {
        const srcAttr = child.attrs.find((a) => a.name === 'src');
        if (!srcAttr) {
          child.attrs.push({ name: 'src', value: '/images/og-default.jpg' });
        } else if (srcAttr.value === '') {
          srcAttr.value = '/images/og-default.jpg';
        }
        // A missing alt is a real accessibility failure; "" (decorative)
        // is the correct default when the source gives no better text -
        // seen on 1x1 affiliate-network tracking pixels, which have none.
        if (!child.attrs.some((a) => a.name === 'alt')) {
          child.attrs.push({ name: 'alt', value: '' });
        }
        // Almost none of these ~1500 embedded images (98%+) carry explicit
        // dimensions, causing layout shift as each one loads in. Lazy
        // loading is a one-line win for every image regardless of source;
        // real width/height needs the actual file, queued for the async
        // pass below since it's local-images only (no point fetching a
        // hotlinked fallback over the network just to size it).
        if (!child.attrs.some((a) => a.name === 'loading')) {
          child.attrs.push({ name: 'loading', value: 'lazy' });
        }
        const finalSrcAttr = child.attrs.find((a) => a.name === 'src')!;
        const hasDimensions = child.attrs.some((a) => a.name === 'width') && child.attrs.some((a) => a.name === 'height');
        if (!hasDimensions && finalSrcAttr.value.startsWith('/images/')) {
          imagesNeedingDimensions.push(child);
        }
      }

      // An <a> without an href isn't a hyperlink - some WordPress widgets
      // (e.g. Elementor's toggle/accordion titles) use one purely as a
      // clickable text wrapper for JS this static site doesn't ship. <span>
      // is the correct tag for that and isn't "interactive content", which
      // matters where these show up nested inside a role="button" element.
      if (child.tagName === 'a' && !child.attrs.some((a) => a.name === 'href')) {
        child.tagName = 'span';
        child.nodeName = 'span';
      }

      const stripSet = child.tagName === 'table'
        ? new Set([...STRIP_ATTRS_GLOBAL, ...STRIP_ATTRS_TABLE])
        : STRIP_ATTRS_GLOBAL;
      child.attrs = child.attrs.filter((attr) => !stripSet.has(attr.name));

      // De-duplicate ids: WordPress product-card/rating widgets are copy-
      // pasted per item, so the same id (e.g. an inline SVG gradient's
      // id="hg") repeats dozens of times in one post. Rename every
      // occurrence after the first, and keep any url(#id)/#id reference
      // on this same element pointed at whichever id is currently active.
      for (const attr of child.attrs) {
        if (attr.name === 'id') {
          const original = attr.value;
          if (!idOccurrences.has(original)) {
            idOccurrences.set(original, 1);
            activeId.set(original, original);
          } else {
            const n = idOccurrences.get(original)! + 1;
            idOccurrences.set(original, n);
            const newId = `${original}-dup${n}`;
            attr.value = newId;
            activeId.set(original, newId);
          }
        }
      }
      for (const attr of child.attrs) {
        if (attr.name === 'id') continue;
        attr.value = attr.value.replace(/url\(#([^)]+)\)/g, (m, id) =>
          activeId.has(id) ? `url(#${activeId.get(id)})` : m,
        );
        if (attr.value.startsWith('#') && activeId.has(attr.value.slice(1))) {
          attr.value = `#${activeId.get(attr.value.slice(1))}`;
        }
      }

      walk(child);
    }
  }
  walk(fragment);

  await Promise.all(imagesNeedingDimensions.map(async (img) => {
    const src = img.attrs.find((a) => a.name === 'src')!.value;
    const dims = await getImageDimensions(src);
    if (dims) {
      img.attrs.push({ name: 'width', value: String(dims.width) });
      img.attrs.push({ name: 'height', value: String(dims.height) });
    }
  }));

  return { html: localizeBody(serialize(fragment)), styles: styles.join('\n') };
}

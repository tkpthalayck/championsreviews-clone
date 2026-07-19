import { parseFragment, serialize, defaultTreeAdapter } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

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

// A handful of WordPress posts contain markup that's malformed against the
// HTML5 spec: <style> blocks placed as arbitrary descendants (only valid in
// <head> or as body's first child), unclosed <p> tags (legacy wpautop
// output), and - in one post - an entire second <!doctype html>...</html>
// document pasted into the content editor. Re-parsing the fragment through
// parse5 (the same tree-construction algorithm browsers use) auto-closes
// implicit tags exactly as a browser would, and lets us pull out the parts
// that don't belong in a content fragment (style/meta/title left over from
// the pasted document) instead of guessing at them with regex.
export function sanitizeBody(rawBody: string): { html: string; styles: string } {
  const fragment = parseFragment(rawBody, { scriptingEnabled: false });
  const styles: string[] = [];

  function walk(parent: ParentNode) {
    const children = defaultTreeAdapter.getChildNodes(parent) ?? [];
    for (const child of [...children]) {
      if (isElement(child)) {
        if (child.tagName === 'style') {
          styles.push(defaultTreeAdapter.getTextNodeContent(child.childNodes[0] as any) ?? '');
          defaultTreeAdapter.detachNode(child);
          continue;
        }
        if (child.tagName === 'meta' || child.tagName === 'title' || child.tagName === 'base') {
          // Leftovers from a full document pasted into the editor - not
          // valid content in a body fragment.
          defaultTreeAdapter.detachNode(child);
          continue;
        }
        walk(child);
      }
    }
  }
  walk(fragment);

  return { html: localizeBody(serialize(fragment)), styles: styles.join('\n') };
}

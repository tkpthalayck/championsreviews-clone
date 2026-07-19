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

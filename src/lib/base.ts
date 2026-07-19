// Astro's import.meta.env.BASE_URL does not reliably carry a trailing
// slash across versions/configs, so every `${base}segment/`-style
// concatenation throughout the site risked producing malformed URLs like
// "/championsreviews-clonereviews/" (missing separator). Normalize once,
// here, and have every page/component import this instead of reading
// BASE_URL directly.
export const BASE = import.meta.env.BASE_URL.replace(/\/?$/, '/');

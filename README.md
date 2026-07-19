# ChampionsReviews.Com — Static Showcase

A premium, blazing-fast static clone of [ChampionsReviews.com](https://championsreviews.com), built with [Astro](https://astro.build) and deployed free on GitHub Pages.

**Live site:** https://tkpthalayck.github.io/championsreviews-clone/

This is a read-only showcase sourced from the live WordPress site's content. It does not run WordPress, PHP, or any backend — everything is pre-rendered static HTML for maximum speed. The "Subscribe" call-to-action links back to the live site, since GitHub Pages can't host that dynamic functionality.

## Tech stack

- **[Astro](https://astro.build)** — static site framework, ships zero JS by default
- **[Tailwind CSS v4](https://tailwindcss.com)** + **[@tailwindcss/typography](https://github.com/tailwindlabs/tailwindcss-typography)** — utility-first styling and article-body typography
- **[Pagefind](https://pagefind.app)** — static, build-time search index, no backend
- **[@astrojs/sitemap](https://docs.astro.build/en/guides/integrations-guide/sitemap/)** — automatic sitemap.xml
- **[parse5](https://github.com/inikulin/parse5)** — sanitizes legacy WordPress body HTML at render time (fixes unclosed tags, hoists stray `<style>` blocks, strips dead JS-widget attributes)

## Project structure

```
src/
  content/
    posts/    — one JSON file per review/comparison post (from export-content.mjs)
    pages/    — one JSON file per migrated static WordPress page
  content.config.ts — content collection schemas
  layouts/BaseLayout.astro — SEO meta, Open Graph, JSON-LD, page shell
  components/ — Header, Footer, PostCard
  pages/
    index.astro — home page
    reviews/ — paginated review listing + [slug].astro individual review template
    category/[category].astro — per-category listing
    search/ — Pagefind-powered search UI
    [...slug].astro — renders migrated static pages (About, Privacy Policy, etc.)
scripts/export-content.mjs — one-time full export from the live WordPress REST API (initial migration)
scripts/sync-content.mjs — incremental daily sync (new/updated posts+pages only)
```

## Commands

| Command | Action |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run dev` | Local dev server at `localhost:4321` |
| `npm run build` | Build to `./dist/` (also runs Pagefind indexing) |
| `npm run preview` | Preview the production build locally |
| `npm run export-content` | Full re-export from championsreviews.com (read-only, safe to re-run) |
| `npm run sync-content` | Incremental sync - only new/updated posts+pages since the last run |

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`: build → broken-link check ([lychee](https://lychee.cli.rs)) → HTML validation → [Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci) budget check (performance/accessibility/SEO/best-practices) → deploy to GitHub Pages via GitHub's official Pages actions.

## Daily content sync

`.github/workflows/sync-content.yml` runs every day at 06:00 UTC (and can be triggered manually from the Actions tab). It:

1. Checks championsreviews.com's WordPress REST API (read-only GETs only - never writes anything back to the live site) for posts/pages that are new or have a newer `modified` timestamp than what's committed here.
2. Writes only those changed items into `src/content/` and any new images into `public/images/` - unrelated content is left untouched.
3. Commits and pushes the changes, which triggers `deploy.yml` to rebuild and redeploy the live site automatically.

If nothing changed on WordPress, the job exits without committing anything - no-op runs don't trigger a rebuild.

**Content intentionally excluded from the clone** (won't be resurrected by the sync even if still present on WordPress) is listed at the top of `scripts/sync-content.mjs`: 19 non-functional WooCommerce/account pages GitHub Pages can't run. (A post whose body was a corrupted Gamma.app export was fixed directly on WordPress on 2026-07-19 and no longer needs excluding.)

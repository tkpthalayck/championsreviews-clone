# ChampionsReviews.Com — Static Showcase

A premium, blazing-fast static clone of [ChampionsReviews.com](https://championsreviews.com), built with [Astro](https://astro.build) and deployed free on GitHub Pages.

**Live site:** https://tkpthalayck.github.io/championsreviews-clone/

This is a read-only showcase sourced from the live WordPress site's content. It does not run WordPress, PHP, or any backend — everything is pre-rendered static HTML for maximum speed. The "Subscribe" call-to-action links back to the live site, since GitHub Pages can't host that dynamic functionality.

## Tech stack

- **[Astro](https://astro.build)** — static site framework, ships zero JS by default
- **[Tailwind CSS v4](https://tailwindcss.com)** — utility-first styling (Vite plugin, no separate config file needed)
- **[Pagefind](https://pagefind.app)** — static, build-time search index, no backend
- **[astro-icon](https://www.astroicon.dev)** — tree-shaken SVG icons
- **[@astrojs/sitemap](https://docs.astro.build/en/guides/integrations-guide/sitemap/)** — automatic sitemap.xml

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
scripts/export-content.mjs — one-time/periodic content export from the live WordPress REST API
```

## Commands

| Command | Action |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run dev` | Local dev server at `localhost:4321` |
| `npm run build` | Build to `./dist/` (also runs Pagefind indexing) |
| `npm run preview` | Preview the production build locally |
| `npm run export-content` | Re-pull latest content from championsreviews.com (read-only, safe to re-run) |

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`: build → broken-link check ([lychee](https://lychee.cli.rs)) → HTML validation → [Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci) budget check (performance/accessibility/SEO/best-practices) → deploy to GitHub Pages via GitHub's official Pages actions.

// Daily automated check for POSSIBLE product-category mismatches in the
// "5 Best Options" / "5 Top-Rated Picks" comparison posts (e.g. a post
// titled "Rack Cabinets" whose actual picks were kitchen cabinet
// organizer shelves - found and fixed manually on 2026-07-20).
//
// This is REPORT-ONLY. It never deletes or modifies any content file.
// An early version of this script auto-deleted on a keyword-rule match
// and was tested against the live corpus once - it flagged 19 posts,
// and on inspection 18 of them were false positives (e.g. a Bose
// soundbar flagged as "not home theater", pliers flagged as "not a
// plumbing tool", solar motion-sensor lights flagged as "not security
// lights" - real products, just described with different words than the
// rule expected). Real product titles use far more varied language than
// any fixed keyword list can anticipate, so a keyword match/non-match is
// only a weak, noisy SIGNAL that something MIGHT be worth a human
// looking at - not evidence a product is actually wrong. Treat every
// finding below as "check this," never as "this is confirmed bad."
//
// What this script does NOT do: decide anything, delete anything, or
// invent a replacement post. There's no live product-data source (e.g.
// Amazon's product API) wired into this repo, so fabricating "a new
// correct product" would mean making up a fake product/price/affiliate
// link - a worse problem than the one being checked for. A confirmed
// mismatch (verified by a human reading the actual product titles, the
// way rack-cabinets-5-top-rated-picks-on-amazon-com-compared was
// verified before removal) gets added to scripts/excluded-posts.json by
// hand, which both this script and sync-content.mjs respect.
import fs from 'node:fs/promises';
import path from 'node:path';
import { RULES, SLUG_PREFIX_TO_TOPIC } from './product-match-rules.mjs';

const POSTS_DIR = path.resolve('src/content/posts');
const EXCLUDED_FILE = path.resolve('scripts/excluded-posts.json');
const REPORT_FILE = path.resolve('product-match-findings.json');

function extractProductTitles(body) {
  return [...body.matchAll(/#\d &mdash; ([^<]+)<\/h3>/g)].map((m) =>
    m[1].replace(/&#\d+;/g, ' ').replace(/&[a-z]+;/gi, ' ').trim(),
  );
}

function topicForSlug(slug) {
  const stripped = slug
    .replace(/-5-(best-options|top-rated-picks)-on-amazon-com-compared(-\d{4})?(-\d+)?$/, '')
    .replace(/-\d+$/, '');
  return SLUG_PREFIX_TO_TOPIC[stripped] ?? null;
}

function checkProduct(title, rule) {
  const lower = title.toLowerCase();
  if (rule.forbidden.some((kw) => lower.includes(kw))) return false;
  if (rule.required.length === 0) return true;
  return rule.required.some((kw) => lower.includes(kw));
}

async function main() {
  const files = (await fs.readdir(POSTS_DIR)).filter((f) => f.endsWith('.json'));
  const excluded = JSON.parse(await fs.readFile(EXCLUDED_FILE, 'utf8'));
  const findings = [];

  for (const file of files) {
    const slug = file.replace(/\.json$/, '');
    if (excluded[slug]) continue; // already handled/known
    const topic = topicForSlug(slug);
    if (!topic) continue; // out of scope - not a known comparison-post template
    const rule = RULES[topic];
    if (!rule) continue;

    const raw = await fs.readFile(path.join(POSTS_DIR, file), 'utf8');
    const j = JSON.parse(raw);
    const products = extractProductTitles(j.body);
    if (products.length === 0) continue;

    const flagged = products.filter((p) => !checkProduct(p, rule));
    if (flagged.length > 0) {
      findings.push({ slug, title: j.title, topic, flagged, totalProducts: products.length });
    }
  }

  if (findings.length === 0) {
    console.log('Product-match audit: nothing flagged for review.');
    await fs.rm(REPORT_FILE, { force: true });
    return;
  }

  console.log(`Product-match audit: ${findings.length} post(s) flagged for HUMAN review (not confirmed mismatches - see script header).`);
  for (const f of findings) {
    console.log(`\n- ${f.slug} (${f.flagged.length}/${f.totalProducts} flagged)`);
    for (const m of f.flagged) console.log(`    ? ${m}`);
  }

  // Written only for the workflow step to turn into a GitHub issue -
  // no content file or excluded-posts.json is ever modified here.
  await fs.writeFile(REPORT_FILE, JSON.stringify(findings, null, 2));
}

main();

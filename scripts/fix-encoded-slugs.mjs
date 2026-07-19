// One-off patch: WordPress returns URL-encoded slugs for posts whose titles
// start with non-ASCII characters (emoji). Astro's static-path matching
// expects the raw decoded slug as the route param (it decodes the request
// path before matching), so an encoded slug like "%f0%9f%8c%90-..." never
// matches during build. Decode the slug field and rename the file to match.
import fs from 'node:fs/promises';
import path from 'node:path';

for (const dir of ['src/content/posts', 'src/content/pages']) {
  const files = await fs.readdir(dir);
  for (const file of files) {
    if (!file.includes('%')) continue;
    const filePath = path.join(dir, file);
    const entry = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const decodedSlug = decodeURIComponent(entry.slug);
    entry.slug = decodedSlug;
    const newFile = path.join(dir, `${decodedSlug}.json`);
    await fs.writeFile(newFile, JSON.stringify(entry, null, 2));
    if (newFile !== filePath) await fs.unlink(filePath);
    console.log(`Fixed: ${file} -> ${decodedSlug}.json`);
  }
}

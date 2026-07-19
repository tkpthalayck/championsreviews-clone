import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const posts = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/posts' }),
  schema: z.object({
    id: z.number(),
    slug: z.string(),
    title: z.string(),
    date: z.string(),
    modified: z.string(),
    excerpt: z.string(),
    categories: z.array(z.string()),
    tags: z.array(z.string()),
    featuredImage: z.string().nullable(),
    body: z.string(),
  }),
});

const pages = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/pages' }),
  schema: z.object({
    id: z.number(),
    slug: z.string(),
    title: z.string(),
    date: z.string(),
    modified: z.string(),
    body: z.string(),
  }),
});

export const collections = { posts, pages };

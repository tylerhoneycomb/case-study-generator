// =============================================================================
// Content collection schema — single source of truth for case-study metadata.
//
// Each MDX file under src/content/case-studies/ has frontmatter validated
// against this Zod schema at build time. Validation failures fail the build,
// which means a malformed agent-generated file cannot reach production.
//
// The 14 Claude output keys from prompts/case-study-prompt.md map here as:
//   - `story` -> the MDX body (rich-text HTML pastes directly into MDX)
//   - everything else -> a frontmatter field (same name)
//   - `slug` is the file name (Astro-derived); not a frontmatter field
//
// Fields supplied by the agent outside Claude (scrape payload, derived values)
// also live in frontmatter so the case-study renderer has one typed object.
// =============================================================================

import { defineCollection, z } from 'astro:content';

// Controlled vocabulary. Mirror this list in the runtime prompt (Section 8 of
// prompts/case-study-prompt.md). Additive only — never rename, to avoid
// orphaning prior case studies.
export const INDUSTRIES = [
  'Food & Beverage',
  'Retail',
  'Health & Wellness',
  'Personal Services',
  'Professional Services',
  'Arts & Entertainment',
  'Manufacturing & Craft',
  'Agriculture',
  'Hospitality',
  'Technology',
  'Education',
  'Other',
] as const;

export type Industry = (typeof INDUSTRIES)[number];

// Lenient schema for the JSON-LD blob. Claude returns a parsed object;
// scripts/generate.ts validates it parses and stays under 8 KB before commit.
const systemSchemaJsonShape = z
  .record(z.string(), z.unknown())
  .refine(
    (obj) => typeof obj['@context'] === 'string' && '@graph' in obj,
    { message: 'systemSchemaJson must be a JSON-LD document with @context and @graph.' }
  );

const caseStudy = defineCollection({
  type: 'content',
  schema: z.object({
      // ---------------------------------------------------------------------
      // Identity
      // ---------------------------------------------------------------------
      businessName: z.string().min(1),
      niche: z.string().min(2).max(80),
      industry: z.enum(INDUSTRIES),
      city: z.string().min(1),
      // Two-letter US state abbreviation. Uppercase enforced.
      state: z.string().length(2).regex(/^[A-Z]{2}$/, 'state must be a 2-letter uppercase abbreviation'),

      // ---------------------------------------------------------------------
      // Headings (per-item, agent-written)
      // ---------------------------------------------------------------------
      h1Heading: z.string().min(20),
      heroSubhead: z.string().min(20),
      storyHeading: z.string().min(4),

      // ---------------------------------------------------------------------
      // Hero / OG image
      // Stored under public/og/{slug}.{ext} per scope Section 5. Path string
      // (not Astro's image() helper) because public/ assets are passed through
      // unprocessed — keeps the agent's image-write logic a single fs.writeFile.
      // ---------------------------------------------------------------------
      heroImage: z.string().regex(/^\/og\/[a-z0-9-]+\.(jpg|jpeg|png|webp|svg)$/i, 'heroImage must be a path under /og/'),
      heroImageAlt: z.string().min(8).max(200),
      // ogImage is usually the same path as heroImage; keep separate so
      // social previews can deviate if a campaign supplies a tailored image.
      ogImage: z.string().regex(/^\/og\/[a-z0-9-]+\.(jpg|jpeg|png|webp|svg)$/i).optional(),

      // ---------------------------------------------------------------------
      // Optional founder quote. Empty in v1 by default; the layout hides the
      // quote block when both fields are absent.
      // ---------------------------------------------------------------------
      quote: z.string().optional(),
      quoteAttribution: z.string().optional(),

      // ---------------------------------------------------------------------
      // Metrics. Numeric fields drive math; *Formatted fields drive display
      // (Wix-era workaround preserved because the agent already produces them
      // and they spare us a render-time formatter on every page).
      // ---------------------------------------------------------------------
      amountRaised: z.number().int().nonnegative(),
      amountRaisedFormatted: z.string(),
      goalAmount: z.number().int().positive(),
      goalAmountFormatted: z.string(),
      percentOfGoal: z.number().nonnegative(),
      percentOfGoalFormatted: z.string(),
      investorCount: z.number().int().nonnegative(),
      // Free-form, agent-derived. Examples: "21 days", "under a week".
      timeToFund: z.string().min(1),

      // ---------------------------------------------------------------------
      // SEO
      // ---------------------------------------------------------------------
      metaTitle: z.string().min(40).max(70),
      metaDescription: z.string().min(120).max(180),
      ogTitle: z.string().min(30).max(80),
      ogDescription: z.string().min(60).max(160),
      canonicalOverride: z.string().url().optional(),

      // ---------------------------------------------------------------------
      // CTA
      // ---------------------------------------------------------------------
      ctaText: z.string().min(3),
      ctaUrl: z.string().url().default('https://honeycombcredit.com/pre-qualify'),

      // ---------------------------------------------------------------------
      // Source traceability — the Honeycomb campaign that produced this page
      // ---------------------------------------------------------------------
      campaignUrl: z.string().url(),
      campaignId: z.string().min(1),
      campaignSlug: z.string().min(1),

      // ---------------------------------------------------------------------
      // Dates
      // ---------------------------------------------------------------------
      publishedDate: z.coerce.date(),

      // ---------------------------------------------------------------------
      // JSON-LD (LocalBusiness + Article). Emitted in <head> by JsonLd.astro.
      // ---------------------------------------------------------------------
      systemSchemaJson: systemSchemaJsonShape,
    }),
});

export const collections = {
  'case-studies': caseStudy,
};

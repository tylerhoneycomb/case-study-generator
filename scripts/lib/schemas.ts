// =============================================================================
// Shared Zod schemas for the agent's brain.
//
// Two distinct contracts:
//   1. ClaudeOutputSchema — the 14 keys Claude must return per the runtime
//      prompt (prompts/case-study-prompt.md Section 4). Any deviation is a
//      generation failure; we fail fast and re-prompt rather than silently
//      ship bad data.
//   2. CampaignSchema — what we extract from invest.honeycombcredit.com's
//      __NEXT_DATA__ blob. Defensive: every field that isn't strictly
//      required for generation is optional, because the Next.js app's shape
//      is not a contract.
//
// The content-collection schema in src/content/config.ts is the third
// contract — what gets persisted to MDX. The agent stitches Claude output +
// campaign data into that shape.
// =============================================================================

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Controlled vocabulary (mirrors src/content/config.ts INDUSTRIES)
// Kept duplicated here so scripts/* don't import from src/, which keeps the
// CLI surface independent of the Astro build runtime.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Claude output (case-study-prompt.md Section 4)
// ---------------------------------------------------------------------------
export const ClaudeOutputSchema = z.object({
  h1Heading: z.string().min(20),
  heroSubhead: z.string().min(20),
  storyHeading: z.string().min(4),
  // Rich-text HTML body. Length-checked loosely (Section 6 of the prompt
  // calls for 800-1200 words; we allow 600-1500 to absorb edge cases).
  story: z.string().min(2000),
  heroImageAlt: z.string().min(8).max(200),
  metaTitle: z.string().min(40).max(70),
  metaDescription: z.string().min(120).max(180),
  ogTitle: z.string().min(30).max(80),
  ogDescription: z.string().min(60).max(160),
  ctaText: z.string().min(3),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'slug must be lowercase kebab-case'),
  niche: z.string().min(2).max(80),
  industry: z.enum(INDUSTRIES),
  // The prompt asks for systemSchemaJson as a stringified JSON-LD payload.
  // We accept either a string (and parse it) or a pre-parsed object.
  systemSchemaJson: z.union([
    z.string(),
    z.record(z.string(), z.unknown()),
  ]),
});

export type ClaudeOutput = z.infer<typeof ClaudeOutputSchema>;

// ---------------------------------------------------------------------------
// Listing entry (one of the ~10 active Fundraising campaigns at
// invest.honeycombcredit.com/)
// ---------------------------------------------------------------------------
export const ListingEntrySchema = z
  .object({
    slug: z.string(),
    campaignName: z.string(),
    campaignStage: z.string(),
    campaignId: z.string(),
  })
  .passthrough();

export type ListingEntry = z.infer<typeof ListingEntrySchema>;

// ---------------------------------------------------------------------------
// Detail page payload (invest.honeycombcredit.com/campaigns/{slug})
// Defensive: only the fields we actually use are required; everything else is
// optional and the agent skips it rather than crash.
// ---------------------------------------------------------------------------
export const CampaignSchema = z
  .object({
    // Identity
    slug: z.string(),
    campaignName: z.string(),
    campaignId: z.string(),
    campaignStage: z.string(),

    // Dates (used to compute timeToFund)
    campaignStartDate: z.string().optional(),
    campaignExpirationDate: z.string().optional(),

    // Metrics
    totalFundsRaised: z.number().nonnegative().optional(),
    campaignTargetAmount: z.number().positive().optional(),
    campaignMinimumAmount: z.number().nonnegative().optional(),
    numInvestors: z.number().int().nonnegative().optional(),

    // Narrative inputs
    summary: z.string().optional(),
    useOfProceeds: z.string().optional(),

    // Owner / business
    issuer: z
      .object({
        businessType: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        website: z.string().optional(),
        description: z.string().optional(),
      })
      .passthrough()
      .optional(),

    // Hero/OG image source
    ogImageUrl: z.string().optional(),
  })
  .passthrough();

export type Campaign = z.infer<typeof CampaignSchema>;

// Shared types for the Collateral Development Agent.
//
// Authoritative references:
//   - docs/collateral_agent_spec_v3_3.md (§ 3, § 5)
//   - prompts/case-study-prompt.md (§ 3, § 4)
//   - docs/sample_payloads/*.json

// ---------- Scraper: listing entries ----------

export interface HoneycombListingEntry {
  slug: string;
  campaignId: string;
  campaignName: string;
  campaignStage: string;
  campaignStartDate: string;
  campaignExpirationDate: string;
  campaignTargetAmount: number;
  campaignMinimumAmount: number;
  investmentType: string;
}

// ---------- Scraper: full campaign payload ----------

export interface HoneycombIssuer {
  businessType: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  description: string | null;
  website: string | null;
  companyName: string | null;
  facebook: string | null;
  instagram: string | null;
  linkedIn: string | null;
  twitter: string | null;
  email: string | null;
}

export interface HoneycombCampaignData {
  slug: string;
  campaignId: string;
  campaignName: string;
  campaignStage: string;
  campaignStartDate: string;
  campaignExpirationDate: string;
  campaignTargetAmount: number;
  campaignMinimumAmount: number;
  investmentType: string;
  summary: string;
  useOfProceeds: string;
  totalFundsRaised: number;
  numInvestors: number;
  annualInterestRate: number | null;
  loanDuration: number | string | null;
  issuer: HoneycombIssuer;
}

export interface HoneycombCampaignPayload {
  campaignData: HoneycombCampaignData;
  ogImageUrl: string | null;
}

// ---------- Claude API: input and output ----------

// Matches prompts/case-study-prompt.md § 3 (input schema).
export interface AgentPromptInput {
  campaignName: string;
  slug: string;
  issuer: {
    businessType: string;
    city: string;
    state: string;
    description: string;
    website: string;
  };
  summary: string;
  useOfProceeds: string;
  totalFundsRaised: number;
  campaignTargetAmount: number;
  numInvestors: number;
  campaignStartDate: string;
  campaignExpirationDate: string;
  investmentType: string;
  annualInterestRate: number | null;
  loanDuration: string | null;
  todayISO: string;
}

// Matches prompts/case-study-prompt.md § 4 (output schema — 14 keys, exact).
export interface GeneratedCaseStudy {
  h1Heading: string;
  heroSubhead: string;
  storyHeading: string;
  story: string;
  heroImageAlt: string;
  metaTitle: string;
  metaDescription: string;
  ogTitle: string;
  ogDescription: string;
  ctaText: string;
  slug: string;
  niche: string;
  industry: string;
  systemSchemaJson: string;
}

// Controlled vocabulary for `industry` (spec § 5.5, prompt § 8).
export const INDUSTRY_VALUES = [
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

export type IndustryValue = (typeof INDUSTRY_VALUES)[number];

// ---------- Wix CMS: case-study item ----------

// Superset of the 14 Claude keys plus metrics, URLs, static fields, status,
// campaign traceability. Agent does NOT write the humanization fields; the
// Wix beforeInsert hook sets them. See spec § 5.
export interface WixCaseStudyItem {
  // Narrative (agent-generated)
  businessName: string;
  slug: string;
  niche: string;
  industry: string;
  city: string;
  state: string;
  h1Heading: string;
  heroSubhead: string;
  storyHeading: string;
  story: string;
  heroImageAlt: string;
  quote: string;
  quoteAttribution: string;
  heroImage: string;

  // Metrics
  amountRaised: number;
  amountRaisedFormatted: string;
  goalAmount: number;
  goalAmountFormatted: string;
  percentOfGoal: number;
  percentOfGoalFormatted: string;
  investorCount: number;
  timeToFund: string;

  // SEO
  metaTitle: string;
  metaDescription: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  canonicalOverride: string;
  ctaText: string;
  ctaUrl: string;
  campaignUrl: string;
  publishedDate: string;

  // System
  status: 'draft' | 'published';
  systemSchemaJson: string;
  campaignId: string;
  campaignSlug: string;
}

export interface WixInsertResult {
  _id: string;
  humanizationChecked: boolean;
  humanizationIssues: string | null;
}

// ---------- Tracker: state files ----------

export interface TrackedCampaignEntry {
  lastKnownStage: string;
  firstSeenISO: string;
  lastCheckedISO?: string;
}

export interface TrackedCampaigns {
  version: 1;
  lastSyncISO: string | null;
  campaigns: Record<string, TrackedCampaignEntry>;
}

export interface ProcessedCampaigns {
  version: 1;
  seededAtISO: string | null;
  seedNote?: string;
  slugs: string[];
}

// ---------- Run report (end-of-run summary) ----------

export interface CampaignReport {
  slug: string;
  businessName: string;
  industry: string;
  niche: string;
  amountRaisedFormatted: string;
  investorCount: number;
  wixItemId: string;
  wixCmsUrl: string;
  publicPreviewUrl: string;
  humanizationChecked: boolean;
  humanizationIssues: string | null;
}

export interface CampaignFailure {
  slug: string;
  stage: 'scrape' | 'generate' | 'upload' | 'insert' | 'notify' | 'unknown';
  message: string;
}

export interface RunReport {
  runStartedISO: string;
  processed: CampaignReport[];
  failures: CampaignFailure[];
  scrapeAnomalies: string[];
  trackedCount: number;
  rechecked: number;
  newlyTracked: number;
}

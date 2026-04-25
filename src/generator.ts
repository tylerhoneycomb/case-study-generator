import Anthropic from '@anthropic-ai/sdk';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  AgentPromptInput,
  GeneratedCaseStudy,
  HoneycombCampaignData,
  INDUSTRY_VALUES,
  IndustryValue,
} from './types';

const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPT_PATH = path.join(REPO_ROOT, 'prompts', 'case-study-prompt.md');
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8000;

const REQUIRED_KEYS: (keyof GeneratedCaseStudy)[] = [
  'h1Heading',
  'heroSubhead',
  'storyHeading',
  'story',
  'heroImageAlt',
  'metaTitle',
  'metaDescription',
  'ogTitle',
  'ogDescription',
  'ctaText',
  'slug',
  'niche',
  'industry',
  'systemSchemaJson',
];

export class GenerationError extends Error {
  constructor(message: string, readonly slug?: string) {
    super(slug ? `[generate ${slug}] ${message}` : `[generate] ${message}`);
    this.name = 'GenerationError';
  }
}

let cachedPrompt: string | null = null;

async function loadPrompt(): Promise<string> {
  if (cachedPrompt) return cachedPrompt;
  cachedPrompt = await fs.readFile(PROMPT_PATH, 'utf8');
  return cachedPrompt;
}

export function buildPromptInput(
  campaign: HoneycombCampaignData,
  todayISO: string,
): AgentPromptInput {
  const issuer = campaign.issuer || ({} as HoneycombCampaignData['issuer']);
  return {
    campaignName: campaign.campaignName ?? '',
    slug: campaign.slug ?? '',
    issuer: {
      businessType: issuer.businessType ?? '',
      city: issuer.city ?? '',
      state: issuer.state ?? '',
      description: issuer.description ?? '',
      website: (issuer.website ?? '').toLowerCase(),
    },
    summary: campaign.summary ?? '',
    useOfProceeds: campaign.useOfProceeds ?? '',
    totalFundsRaised: Number(campaign.totalFundsRaised ?? 0),
    campaignTargetAmount: Number(campaign.campaignTargetAmount ?? 0),
    numInvestors: Number(campaign.numInvestors ?? 0),
    campaignStartDate: campaign.campaignStartDate ?? '',
    campaignExpirationDate: campaign.campaignExpirationDate ?? '',
    investmentType: campaign.investmentType ?? '',
    annualInterestRate:
      campaign.annualInterestRate == null ? null : Number(campaign.annualInterestRate),
    loanDuration:
      campaign.loanDuration == null ? null : String(campaign.loanDuration),
    todayISO,
  };
}

function stripFences(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

function validateOutput(parsed: unknown, slug: string): GeneratedCaseStudy {
  if (!parsed || typeof parsed !== 'object') {
    throw new GenerationError('output is not an object', slug);
  }
  const out = parsed as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) {
    if (typeof out[key] !== 'string' || !out[key]) {
      throw new GenerationError(`missing or non-string key "${key}"`, slug);
    }
  }
  if (!INDUSTRY_VALUES.includes(out.industry as IndustryValue)) {
    throw new GenerationError(
      `industry "${out.industry}" not in controlled vocabulary`,
      slug,
    );
  }
  const mt = (out.metaTitle as string).length;
  if (mt < 50 || mt > 60) {
    throw new GenerationError(`metaTitle length ${mt} not in 50-60`, slug);
  }
  const md = (out.metaDescription as string).length;
  if (md < 140 || md > 160) {
    throw new GenerationError(`metaDescription length ${md} not in 140-160`, slug);
  }
  const schema = out.systemSchemaJson as string;
  if (schema.length >= 8000) {
    throw new GenerationError(`systemSchemaJson length ${schema.length} >= 8000`, slug);
  }
  try {
    JSON.parse(schema);
  } catch (err) {
    throw new GenerationError(
      `systemSchemaJson is not valid JSON: ${(err as Error).message}`,
      slug,
    );
  }
  return out as unknown as GeneratedCaseStudy;
}

export async function generateCaseStudy(
  input: AgentPromptInput,
  apiKey: string,
): Promise<GeneratedCaseStudy> {
  const system = await loadPrompt();
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: JSON.stringify(input) }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new GenerationError('no text content in Claude response', input.slug);
  }
  const raw = stripFences(textBlock.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GenerationError(
      `response did not parse as JSON: ${(err as Error).message}`,
      input.slug,
    );
  }
  return validateOutput(parsed, input.slug);
}

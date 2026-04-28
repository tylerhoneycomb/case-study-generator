// =============================================================================
// Anthropic API client — wraps prompts/case-study-prompt.md.
//
// One public function: generateCaseStudy(payload) → ClaudeOutput + cost.
// The prompt's input contract (Section 3) is encoded in the InputPayload type
// below. The agent assembles this payload from a scraped Campaign + today's
// date and any caller-supplied feedback.
//
// Model: claude-opus-4-7 by default (latest as of 2026-04). Override via
// the CASE_STUDY_MODEL env var if you want to A/B against another tier.
// =============================================================================

import Anthropic from '@anthropic-ai/sdk';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ClaudeOutputSchema, type ClaudeOutput } from './schemas.js';

const DEFAULT_MODEL = process.env['CASE_STUDY_MODEL'] ?? 'claude-opus-4-7';
const MAX_OUTPUT_TOKENS = 4096;

// Load the prompt once per process.
let cachedPrompt: string | null = null;
async function loadPrompt(): Promise<string> {
  if (cachedPrompt) return cachedPrompt;
  const file = path.resolve(process.cwd(), 'prompts/case-study-prompt.md');
  cachedPrompt = await fs.readFile(file, 'utf8');
  return cachedPrompt;
}

// Per the prompt's Section 3. The agent's job is to assemble this from the
// scraped campaign payload before calling generateCaseStudy.
export interface InputPayload {
  campaignName: string;
  campaignSlug: string;
  campaignId: string;
  todayISO: string;
  city: string;
  state: string;
  totalFundsRaised: number;
  campaignTargetAmount: number;
  numInvestors: number;
  campaignStartDate: string;
  campaignExpirationDate: string;
  // Free-form HTML from the campaign page; passed through to Claude
  summary: string;
  useOfProceeds?: string;
  issuerWebsite?: string;
  issuerDescription?: string;
  ogImageUrl?: string;
  // Optional: caller-supplied feedback (used by redraft.ts to steer the model
  // away from issues flagged in a previous generation)
  redraftFeedback?: string;
}

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  // Estimated $ cost. Pricing reference is the public Anthropic pricing page
  // for the active model. Recompute when we change DEFAULT_MODEL.
  estimatedCostUsd: number;
}

// Pricing in USD per million tokens. Keep in sync with the active model.
// Opus 4.7 (per anthropic.com/pricing): $15 input / $75 output per Mtok.
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? PRICING['claude-opus-4-7'];
  if (!p) return 0;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

function getClient(): Anthropic {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. In CI, set it as a repo secret. Locally, add it to .env.',
    );
  }
  return new Anthropic({ apiKey });
}

export interface GenerateResult {
  output: ClaudeOutput;
  // The same JSON-LD blob, parsed. May be an array of typed entities (the
  // canonical prompt-§9 shape), a single typed object, or an @graph wrapper.
  // Validated by isValidJsonLd() before this is set.
  systemSchemaJsonParsed: unknown;
  usage: ClaudeUsage;
  // Raw model response for logging / debugging.
  raw: string;
}

export async function generateCaseStudy(payload: InputPayload): Promise<GenerateResult> {
  const client = getClient();
  const systemPrompt = await loadPrompt();
  const model = DEFAULT_MODEL;

  const userMessage = formatUserMessage(payload);

  const response = await client.messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  // Concatenate any text blocks. Claude should return a single text block
  // since the prompt forbids preamble + commentary.
  const text = response.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');

  if (!text) {
    throw new ClaudeError('EMPTY_RESPONSE', 'Claude returned no text content.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ClaudeError(
      'JSON_PARSE_FAILED',
      `Claude response did not parse as JSON: ${(err as Error).message}\nFirst 500 chars:\n${text.slice(0, 500)}`,
    );
  }

  const validated = ClaudeOutputSchema.safeParse(parsed);
  if (!validated.success) {
    throw new ClaudeError(
      'OUTPUT_VALIDATION_FAILED',
      `Claude output failed schema validation:\n${validated.error.message}`,
    );
  }

  // Resolve systemSchemaJson to a parsed value regardless of whether the
  // model returned a string, object, or array. The runtime prompt §9 calls
  // for an array of two JSON-LD entities (one LocalBusiness/subtype, one
  // Article); we also accept a single object or a {@graph: [...]} wrapper
  // for resilience to prompt evolution and editor convenience.
  let systemSchemaJsonParsed: unknown;
  if (typeof validated.data.systemSchemaJson === 'string') {
    try {
      systemSchemaJsonParsed = JSON.parse(validated.data.systemSchemaJson) as unknown;
    } catch (err) {
      throw new ClaudeError(
        'SYSTEM_SCHEMA_PARSE_FAILED',
        `systemSchemaJson string failed to parse: ${(err as Error).message}`,
      );
    }
  } else {
    systemSchemaJsonParsed = validated.data.systemSchemaJson;
  }

  if (!isValidJsonLd(systemSchemaJsonParsed)) {
    throw new ClaudeError(
      'SYSTEM_SCHEMA_SHAPE',
      'systemSchemaJson must be a JSON-LD array of typed objects, a single typed object, or an object with @graph.',
    );
  }

  const sysJsonString = JSON.stringify(systemSchemaJsonParsed);
  if (sysJsonString.length > 8000) {
    throw new ClaudeError(
      'SYSTEM_SCHEMA_TOO_LARGE',
      `systemSchemaJson is ${sysJsonString.length} chars; cap is 8000.`,
    );
  }

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  return {
    output: validated.data,
    systemSchemaJsonParsed,
    raw: text,
    usage: {
      inputTokens,
      outputTokens,
      estimatedCostUsd: estimateCost(model, inputTokens, outputTokens),
    },
  };
}

// Estimate cost without calling the API. Used by /funded cost-estimate.
// Calibrated against the first real generation (The-Saucy-African,
// 16923 input + 2813 output = $0.465 on Opus 4.7). The runtime prompt
// itself is ~14k tokens; campaign payloads add 2-4k; output is consistently
// ~2.5-3k. Recalibrate if median real generations diverge.
export function estimateCostForGeneration(model: string = DEFAULT_MODEL): number {
  return estimateCost(model, 17000, 2800);
}

function formatUserMessage(p: InputPayload): string {
  // Per the prompt's Section 3, the input is a JSON-shaped block. Match the
  // example payload format from Section 15.1.
  const obj: Record<string, unknown> = {
    campaignName: p.campaignName,
    campaignSlug: p.campaignSlug,
    campaignId: p.campaignId,
    todayISO: p.todayISO,
    city: p.city,
    state: p.state,
    totalFundsRaised: p.totalFundsRaised,
    campaignTargetAmount: p.campaignTargetAmount,
    numInvestors: p.numInvestors,
    campaignStartDate: p.campaignStartDate,
    campaignExpirationDate: p.campaignExpirationDate,
    summary: p.summary,
  };
  if (p.useOfProceeds) obj['useOfProceeds'] = p.useOfProceeds;
  if (p.issuerWebsite) obj['issuerWebsite'] = p.issuerWebsite;
  if (p.issuerDescription) obj['issuerDescription'] = p.issuerDescription;
  if (p.ogImageUrl) obj['ogImageUrl'] = p.ogImageUrl;

  const json = JSON.stringify(obj, null, 2);

  if (p.redraftFeedback) {
    return `INPUT PAYLOAD:\n\n${json}\n\nREVIEWER FEEDBACK ON A PRIOR DRAFT — apply these corrections without changing anything else:\n\n${p.redraftFeedback}`;
  }
  return `INPUT PAYLOAD:\n\n${json}`;
}

export class ClaudeError extends Error {
  constructor(public override readonly name: string, message: string) {
    super(message);
  }
}

// Accept any of the three valid JSON-LD shapes per the runtime prompt §9
// and adjacent JSON-LD spec patterns:
//   1. Array of typed objects:   [{"@context":...,"@type":...}, ...]   ← prompt-canonical
//   2. Object with @graph:       {"@context":..., "@graph":[...]}       ← legacy placeholder shape
//   3. Single typed object:      {"@context":..., "@type":...}          ← spec-allowed
function isValidJsonLd(data: unknown): boolean {
  if (Array.isArray(data)) {
    if (data.length === 0) return false;
    return data.every(isJsonLdEntity);
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj['@context'] !== 'string' && typeof obj['@context'] !== 'object') return false;
    if (Array.isArray(obj['@graph'])) return true;
    return typeof obj['@type'] === 'string';
  }
  return false;
}

function isJsonLdEntity(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const obj = item as Record<string, unknown>;
  return typeof obj['@type'] === 'string';
}

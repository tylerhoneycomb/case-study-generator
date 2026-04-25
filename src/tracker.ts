import { promises as fs } from 'fs';
import * as path from 'path';
import {
  TrackedCampaigns,
  ProcessedCampaigns,
  TrackedCampaignEntry,
} from './types';

const REPO_ROOT = path.resolve(__dirname, '..');
const TRACKED_PATH = path.join(REPO_ROOT, 'data', 'tracked_campaigns.json');
const PROCESSED_PATH = path.join(REPO_ROOT, 'data', 'processed_campaigns.json');

export async function loadTracked(): Promise<TrackedCampaigns> {
  const raw = await fs.readFile(TRACKED_PATH, 'utf8');
  return JSON.parse(raw) as TrackedCampaigns;
}

export async function loadProcessed(): Promise<ProcessedCampaigns> {
  const raw = await fs.readFile(PROCESSED_PATH, 'utf8');
  return JSON.parse(raw) as ProcessedCampaigns;
}

export async function saveTracked(state: TrackedCampaigns): Promise<void> {
  await fs.writeFile(TRACKED_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export async function saveProcessed(state: ProcessedCampaigns): Promise<void> {
  await fs.writeFile(PROCESSED_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function markSeenFundraising(
  state: TrackedCampaigns,
  slug: string,
  todayISO: string,
): boolean {
  const existing = state.campaigns[slug];
  if (existing) {
    existing.lastKnownStage = 'Fundraising';
    return false;
  }
  const entry: TrackedCampaignEntry = {
    lastKnownStage: 'Fundraising',
    firstSeenISO: todayISO,
  };
  state.campaigns[slug] = entry;
  return true;
}

export function updateStage(
  state: TrackedCampaigns,
  slug: string,
  stage: string,
  todayISO: string,
): void {
  const existing = state.campaigns[slug];
  if (existing) {
    existing.lastKnownStage = stage;
    existing.lastCheckedISO = todayISO;
  } else {
    state.campaigns[slug] = {
      lastKnownStage: stage,
      firstSeenISO: todayISO,
      lastCheckedISO: todayISO,
    };
  }
}

export function candidatesForTransitionCheck(
  tracked: TrackedCampaigns,
  processed: ProcessedCampaigns,
): string[] {
  const processedSet = new Set(processed.slugs);
  return Object.entries(tracked.campaigns)
    .filter(([slug, entry]) => entry.lastKnownStage !== 'Funded' && !processedSet.has(slug))
    .map(([slug]) => slug);
}

export function markProcessed(state: ProcessedCampaigns, slug: string): void {
  if (!state.slugs.includes(slug)) state.slugs.push(slug);
}

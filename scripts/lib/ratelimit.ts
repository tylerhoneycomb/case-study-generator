// =============================================================================
// Rate limit ledger — .state/ratelimit.json.
//
// Cap: 1 generation per UTC day across all triggers (cron + manual + backfill).
// Backfill operations may pass an override (capped at 10/day) for a single
// run; the override applies only to that operation's check, not to other
// callers within the same day.
//
// Day boundary: UTC midnight (00:00 UTC). Counter auto-resets on the first
// check of a new day.
//
// State file shape:
//   { "date": "2026-04-28", "used": 2 }
// =============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';

const STATE_FILE = path.resolve(process.cwd(), '.state/ratelimit.json');
const DEFAULT_CAP = 1;
const HARD_MAX_OVERRIDE = 10;

interface RateLimitState {
  date: string;
  used: number;
}

function todayUTC(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function readState(): Promise<RateLimitState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RateLimitState>;
    if (typeof parsed.date === 'string' && typeof parsed.used === 'number') {
      // Stale day → reset.
      if (parsed.date !== todayUTC()) {
        return { date: todayUTC(), used: 0 };
      }
      return { date: parsed.date, used: parsed.used };
    }
  } catch (err) {
    // ENOENT (first run) → fresh state. Anything else → also fresh; the
    // detection cron's tracking issue surfaces persistent corruption.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[ratelimit] state file read failed (${(err as Error).message}); starting fresh.`);
    }
  }
  return { date: todayUTC(), used: 0 };
}

async function writeState(state: RateLimitState): Promise<void> {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export interface RateStatus {
  used: number;
  cap: number;
  remaining: number;
  date: string;
}

export async function status(cap: number = DEFAULT_CAP): Promise<RateStatus> {
  const state = await readState();
  return {
    used: state.used,
    cap,
    remaining: Math.max(0, cap - state.used),
    date: state.date,
  };
}

// Consume N tokens. Returns the post-consume state. Throws RateLimitExceeded
// if the call would exceed the cap. Caller decides whether to surface the
// error or queue the operation.
export class RateLimitExceeded extends Error {
  constructor(public readonly remaining: number, public readonly cap: number) {
    super(`Rate limit exceeded. ${remaining}/${cap} remaining today.`);
    this.name = 'RateLimitExceeded';
  }
}

export interface ConsumeOptions {
  // Override the cap for THIS call only. Capped at HARD_MAX_OVERRIDE (10).
  // Used by the Backfill issue form's "Rate override (per day)" field.
  capOverride?: number;
  count?: number;
}

export async function consume(opts: ConsumeOptions = {}): Promise<RateStatus> {
  const count = opts.count ?? 1;
  const cap = Math.min(opts.capOverride ?? DEFAULT_CAP, HARD_MAX_OVERRIDE);
  const state = await readState();
  if (state.used + count > cap) {
    throw new RateLimitExceeded(cap - state.used, cap);
  }
  const next: RateLimitState = { date: state.date, used: state.used + count };
  await writeState(next);
  return { used: next.used, cap, remaining: cap - next.used, date: next.date };
}

// Read-only check without consuming.
export async function canConsume(opts: ConsumeOptions = {}): Promise<boolean> {
  const count = opts.count ?? 1;
  const cap = Math.min(opts.capOverride ?? DEFAULT_CAP, HARD_MAX_OVERRIDE);
  const state = await readState();
  return state.used + count <= cap;
}

export const constants = {
  DEFAULT_CAP,
  HARD_MAX_OVERRIDE,
  STATE_FILE,
} as const;

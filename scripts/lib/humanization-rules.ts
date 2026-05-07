// =============================================================================
// Humanization rules — single source of truth.
//
// Both consumers read from this file:
//   - scripts/lib/humanize.ts         → builds the validator's regex set
//   - scripts/lib/claude.ts           → injects rule lists into the runtime
//                                       prompt before sending to Claude
//
// Edit the lists below to add or remove a banned phrase / opener and both
// the validator and the prompt update automatically. There is no other place
// these strings should be hardcoded.
// =============================================================================

// Apostrophe class covers ASCII ' and Unicode right-single-quote U+2019.
// Same character class the validator has used since v1.
const APOS = "['’]";

// A banned phrase has two faces: the human-readable form we show to the
// model in the prompt, and the regex source we feed to the validator. They
// are usually identical, but a few entries collapse verb-stem variants
// ("unlock / unlocks / unlocked") into one regex while still showing a
// single canonical form in the prompt.
export interface PhrasePattern {
  display: string;
  regexSource: string;
}

// 12.2 banned vocabulary. Each entry's regexSource is wrapped in word
// boundaries when the validator compiles its big alternation; do not add
// `\b` here.
export const BANNED_VOCABULARY: PhrasePattern[] = [
  { display: 'delve', regexSource: 'delve' },
  { display: 'tapestry', regexSource: 'tapestry' },
  { display: 'landscape of', regexSource: 'landscape of' },
  { display: 'groundbreaking', regexSource: 'groundbreaking' },
  { display: 'revolutionize', regexSource: 'revolutionize' },
  { display: 'ever-evolving', regexSource: 'ever[- ]evolving' },
  { display: 'transform the way', regexSource: 'transform the way' },
  { display: 'unlock the potential', regexSource: 'unlock(s|ed)? the potential' },
  { display: 'navigate the complex', regexSource: 'navigate the complex' },
  { display: 'foster a sense of', regexSource: 'foster(s|ed)? a sense of' },
  { display: 'harness the power', regexSource: 'harness(es|ed)? the power' },
];

// 12.1 hedge phrases. The same APOS class handles curly + straight
// apostrophes uniformly across all entries.
export const BANNED_HEDGE_PHRASES: PhrasePattern[] = [
  { display: "it's worth noting", regexSource: `it${APOS}s worth noting` },
  { display: "it's important to note", regexSource: `it${APOS}s important to note` },
  { display: "it's important to remember", regexSource: `it${APOS}s important to remember` },
  { display: "it's important to understand", regexSource: `it${APOS}s important to understand` },
  { display: 'at the end of the day', regexSource: 'at the end of the day' },
  { display: 'when it comes to', regexSource: 'when it comes to' },
  { display: 'needless to say', regexSource: 'needless to say' },
  { display: "in today's world", regexSource: `in today${APOS}s world` },
  { display: "in today's landscape", regexSource: `in today${APOS}s landscape` },
  { display: "in today's environment", regexSource: `in today${APOS}s environment` },
];

// 12.1 "not just/only/merely/simply X but Y" pivots. The validator builds
// the full regex; the prompt embeds the list of allowed-but-banned pivots.
export const NOT_JUST_BUT_PIVOTS: string[] = ['just', 'only', 'merely', 'simply'];

// 12.3 generic openers. The first sentence of `story` must not begin with
// any of these.
export const BANNED_OPENERS: string[] = [
  "in today's",
  'in the world of',
  'imagine a',
  'picture this',
  'have you ever wondered',
];

// 12.4 density thresholds. The validator flags when matches per 500 words
// exceeds the threshold. Both numbers are exclusive ceilings — exactly at
// the threshold passes; over it fails.
export const DENSITY_THRESHOLDS = {
  // Em-dash (—) overuse threshold. > N per 500 words trips the validator.
  emDashesPer500Words: 3,
  // Tricolon ("X, Y, and Z" with 1-3 word items) overuse threshold.
  tricolonsPer500Words: 2,
} as const;

// ---------------------------------------------------------------------------
// AITell — the shape humanize.ts consumes. Kept here so adding a rule
// requires touching only this file.
// ---------------------------------------------------------------------------

export interface AITell {
  type: string;
  regex: RegExp;
  message: string;
  densityThreshold?: number;
  isDensityCheck?: boolean;
}

// Compose all phrase-pattern entries into a single alternation regex
// wrapped in word boundaries. Used for ai_vocab and hedge_phrase.
function alternation(patterns: PhrasePattern[]): string {
  return patterns.map((p) => p.regexSource).join('|');
}

export function buildAITells(): AITell[] {
  return [
    {
      type: 'not_just_but',
      regex: new RegExp(
        `\\bnot (${NOT_JUST_BUT_PIVOTS.join('|')})\\b[^.!?]{3,80}?\\bbut\\b`,
        'gi',
      ),
      message: '"not just/only/merely X but Y" construction — rewrite without the pivot.',
    },
    {
      type: 'hedge_phrase',
      regex: new RegExp(`\\b(${alternation(BANNED_HEDGE_PHRASES)})\\b`, 'gi'),
      message: 'Hedge or filler phrase — cut or replace with something concrete.',
    },
    {
      type: 'ai_vocab',
      regex: new RegExp(`\\b(${alternation(BANNED_VOCABULARY)})\\b`, 'gi'),
      message: 'AI-overused vocabulary — swap for plainer language.',
    },
    {
      type: 'generic_opener',
      regex: new RegExp(
        `^(\\s*<[^>]+>\\s*)*(${BANNED_OPENERS.map(escapeForRegex).join('|')})`,
        'i',
      ),
      message: 'Generic opener — start with something specific to this business.',
    },
    {
      type: 'tricolon_list',
      // "A, B, and C" where each item is 1-3 words. Density-checked.
      regex: /\b(\w+(?:\s\w+){0,2}), (\w+(?:\s\w+){0,2}), and (\w+(?:\s\w+){0,2})\b/g,
      message: 'Tricolon (three-item parallel list) — over-reliance suggests AI rhythm.',
      densityThreshold: DENSITY_THRESHOLDS.tricolonsPer500Words,
      isDensityCheck: true,
    },
    {
      type: 'em_dash_overuse',
      regex: /—/g,
      message: 'Em-dash overuse — AI writing leans heavily on them.',
      densityThreshold: DENSITY_THRESHOLDS.emDashesPer500Words,
      isDensityCheck: true,
    },
  ];
}

// Escape regex metacharacters in a literal string. Used for openers (which
// are matched as plain prefixes, not patterns).
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Prompt template substitutions.
// claude.ts calls this and runs each entry as a literal find/replace on the
// loaded prompt. Placeholders use the {{HUMANIZATION_*}} convention.
// ---------------------------------------------------------------------------

export interface PromptSubstitutions {
  HUMANIZATION_BANNED_VOCABULARY: string;
  HUMANIZATION_BANNED_HEDGE_PHRASES: string;
  HUMANIZATION_BANNED_OPENERS: string;
  HUMANIZATION_NOT_JUST_BUT_PIVOTS: string;
  HUMANIZATION_EM_DASH_THRESHOLD: string;
  HUMANIZATION_TRICOLON_THRESHOLD: string;
}

export function buildPromptSubstitutions(): PromptSubstitutions {
  const bullets = (lines: string[]): string => lines.map((l) => `- ${l}`).join('\n');
  return {
    HUMANIZATION_BANNED_VOCABULARY: BANNED_VOCABULARY.map((p) => `\`${p.display}\``).join(', '),
    HUMANIZATION_BANNED_HEDGE_PHRASES: bullets(
      BANNED_HEDGE_PHRASES.map((p) => `"${p.display}…"`),
    ),
    HUMANIZATION_BANNED_OPENERS: BANNED_OPENERS.map((o) => `\`${o}\``).join(', '),
    HUMANIZATION_NOT_JUST_BUT_PIVOTS: NOT_JUST_BUT_PIVOTS.map((p) => `\`${p}\``).join(' / '),
    HUMANIZATION_EM_DASH_THRESHOLD: String(DENSITY_THRESHOLDS.emDashesPer500Words),
    HUMANIZATION_TRICOLON_THRESHOLD: String(DENSITY_THRESHOLDS.tricolonsPer500Words),
  };
}

// Apply all substitutions to a loaded prompt string. Idempotent —
// re-running on already-substituted text is a no-op.
export function applyPromptSubstitutions(prompt: string): string {
  const subs = buildPromptSubstitutions();
  let out = prompt;
  for (const [key, value] of Object.entries(subs)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

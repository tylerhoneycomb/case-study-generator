// =============================================================================
// Humanization validator — TypeScript port of backend/humanization.jsw.
//
// Detects common AI-writing tells in long-form copy. Regex-based floor, not a
// semantic analyzer. Catches the most common patterns that show up in
// model-generated prose.
//
// Behavior identical to the Velo original:
//   - validateCopy(plainText) → { passed, issues, wordCount }
//   - density-checked rules (em-dash, tricolon list) flag only when density
//     exceeds the threshold per 500 words
//   - other rules flag on first occurrence
//
// Extend AI_TELLS as new patterns emerge. Mirror any additions in the
// runtime prompt's Section 12 so the agent doesn't generate copy that
// trips a rule we didn't tell it about.
// =============================================================================

interface AITell {
  type: string;
  regex: RegExp;
  message: string;
  densityThreshold?: number;
  isDensityCheck?: boolean;
}

export interface HumanizationIssue {
  type: string;
  message: string;
  count?: number;
  per500Words?: number;
  examples?: string[];
}

export interface HumanizationResult {
  passed: boolean;
  issues: HumanizationIssue[];
  wordCount: number;
}

// Apostrophe class covers ASCII ' and Unicode right-single-quote U+2019.
const APOS = "['’]";

const AI_TELLS: AITell[] = [
  {
    type: 'not_just_but',
    regex: /\bnot (just|only|merely|simply)\b[^.!?]{3,80}?\bbut\b/gi,
    message: '"not just/only/merely X but Y" construction — rewrite without the pivot.',
  },
  {
    type: 'hedge_phrase',
    regex: new RegExp(
      `\\b(it${APOS}s worth noting|it${APOS}s important to (note|remember|understand)|at the end of the day|when it comes to|needless to say|in today${APOS}s (world|landscape|environment))\\b`,
      'gi',
    ),
    message: 'Hedge or filler phrase — cut or replace with something concrete.',
  },
  {
    type: 'ai_vocab',
    regex: /\b(delve|tapestry|landscape of|groundbreaking|revolutionize|ever[- ]evolving|transform the way|unlock(s|ed)? the potential|navigate the complex|foster(s|ed)? a sense of|harness(es|ed)? the power)\b/gi,
    message: 'AI-overused vocabulary — swap for plainer language.',
  },
  {
    type: 'generic_opener',
    regex: new RegExp(
      `^(\\s*<[^>]+>\\s*)*(in today${APOS}s|in the world of|imagine a|picture this|have you ever wondered)`,
      'i',
    ),
    message: 'Generic opener — start with something specific to this business.',
  },
  {
    type: 'tricolon_list',
    // "A, B, and C" where each item is 1-3 words. Density-checked.
    regex: /\b(\w+(?:\s\w+){0,2}), (\w+(?:\s\w+){0,2}), and (\w+(?:\s\w+){0,2})\b/g,
    message: 'Tricolon (three-item parallel list) — over-reliance suggests AI rhythm.',
    densityThreshold: 2,
    isDensityCheck: true,
  },
  {
    type: 'em_dash_overuse',
    regex: /—/g,
    message: 'Em-dash overuse — AI writing leans heavily on them.',
    densityThreshold: 3,
    isDensityCheck: true,
  },
];

export function validateCopy(plainText: string): HumanizationResult {
  if (!plainText || plainText.trim().length === 0) {
    return {
      passed: false,
      issues: [{ type: 'empty', message: 'No copy to validate.' }],
      wordCount: 0,
    };
  }

  const wordCount = plainText.split(/\s+/).filter(Boolean).length;
  const issues: HumanizationIssue[] = [];

  for (const tell of AI_TELLS) {
    const matches = plainText.match(tell.regex);
    if (!matches) continue;

    if (tell.isDensityCheck && tell.densityThreshold !== undefined) {
      const per500 = (matches.length / wordCount) * 500;
      if (per500 > tell.densityThreshold) {
        issues.push({
          type: tell.type,
          message: tell.message,
          count: matches.length,
          per500Words: Math.round(per500 * 10) / 10,
        });
      }
    } else {
      issues.push({
        type: tell.type,
        message: tell.message,
        count: matches.length,
        examples: matches.slice(0, 3),
      });
    }
  }

  return { passed: issues.length === 0, issues, wordCount };
}

// Strip HTML tags + decode common entities so rich-text fields can be
// validated as plain text.
export function stripHtml(richText: string | null | undefined): string {
  if (!richText) return '';
  return String(richText)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Format an issue list as a reviewer-readable string. Used for issue comments
// when the validator fails so the operator can see what to fix.
export function formatIssuesForReviewer(issues: HumanizationIssue[]): string {
  if (issues.length === 0) return '';
  return issues
    .map((issue, idx) => {
      const lines = [`${idx + 1}. [${issue.type}] ${issue.message}`];
      if (issue.count !== undefined) lines.push(`   Found ${issue.count} occurrence(s).`);
      if (issue.per500Words !== undefined)
        lines.push(`   Density: ${issue.per500Words} per 500 words.`);
      if (issue.examples && issue.examples.length) {
        lines.push(`   Examples: ${issue.examples.map((e) => `"${e}"`).join(', ')}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

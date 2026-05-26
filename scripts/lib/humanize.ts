// =============================================================================
// Humanization validator — AI-writing tell detector.
//
// Detects common AI-writing tells in long-form copy. Regex-based floor, not
// a semantic analyzer. Called by pipeline.ts after every Claude response.
//
// Retry policy (see pipeline.ts):
//   Attempt 1: generate normally, then validate.
//   If validation fails: re-call Claude once with the flagged issues as
//     targeted feedback (attempt 2).
//   If attempt 2 also fails: publish anyway; caller applies a
//     `humanization-warning` label to the tracking issue.
//
// This is a soft gate in practice. The runtime prompt (§13.5) still frames
// the validator as a hard gate to motivate clean first-pass output — Claude
// should not be aware of the publish fallback.
//
// All rules live in scripts/lib/humanization-rules.ts. That file is the
// single source of truth — both this validator and the runtime prompt
// (via prompts/case-study-prompt.md template substitution) read from it.
// =============================================================================

import { buildAITells, type AITell } from './humanization-rules.js';

export type { AITell };

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

const AI_TELLS: AITell[] = buildAITells();

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

// Format an issue list as a reviewer-readable string. Used for the
// PipelineError message when validation blocks a generation.
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

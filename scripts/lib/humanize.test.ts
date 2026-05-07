// =============================================================================
// Pin the humanization validator's behavior. Each AI tell pattern gets at
// least one positive case (must flag) and a clean baseline (must pass).
// Density-checked rules verify both above- and below-threshold behavior.
// =============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateCopy, stripHtml, formatIssuesForReviewer } from './humanize.js';
import { applyPromptSubstitutions } from './humanization-rules.js';

// ~500 words, deliberately written to avoid every AI tell pattern. Used as
// the baseline that should pass cleanly. Density-edge tests append small
// amounts of flagged content so the per-500-words math reflects real usage.
const PASSING_BODY = `
Sarah opened her bone-broth shop in 2022 with a single induction burner and
a rented walk-in cooler. By the third winter she was selling out by
Wednesday afternoon and turning away wholesale orders from two restaurants
on the same block. The Honeycomb raise paid for a second burner. It paid
for six months of overflow rent at a kitchen across the alley. It paid for
a part-time prep cook who works the early shift four days a week. Three
weeks after the campaign closed, weekend sellouts stopped happening on
Sundays. She still sells out most Saturdays, but she likes that part. It
keeps the menu honest and the staff sharp.

She had been pre-qualified for a traditional bank loan at a slightly lower
headline rate. She went with a community raise for two reasons. The bank
loan required a personal guarantee against her house, and she wanted the
people who already shopped at the counter to have a small ownership stake
in what came next. The investors get monthly interest payments. Sarah keeps
her home off the table. Both sides know what they signed up for.

The campaign window itself was quieter than she expected. She wrote one
email to her existing customer list at launch. She posted twice on the
shop's social accounts. She printed a single eight-by-eleven flyer for the
storefront window. The Honeycomb team handled the legal documents, the
investor accreditation checks, and disbursement. Sarah spent about thirty
hours preparing the campaign and another ten hours during the active
window answering questions in the campaign-page comments and recording
short updates from the prep table.

Her customers brought the early momentum. The middle weeks brought new
investors who heard about the raise on a neighborhood newsletter. The last
week pulled in former neighbors who had moved away years ago and wanted to
back something they remembered fondly. The campaign closed in nineteen days
at one hundred and forty percent of the goal. A hundred and thirty-two
people invested.

What changed when the goal hit. The second burner was installed inside
three weeks. Wholesale capacity went from forty-eight liters a day to a
hundred and twenty. The overflow kitchen across the alley took the prep
work that used to happen on the main counter. Customers stopped seeing
buckets of broth cooling next to the register, which everyone agreed was
an improvement.

What Sarah tells other owners considering a community raise. The work is
mostly upfront. The money is real money that comes with real obligations.
The campaign window is straightforward if your existing customers carry
the early momentum. The repayment is a line item she budgets for every
month, the same way she budgets for rent and labor. She does not
romanticize either part. She built a shop that already had a loyal
following and a campaign that asked those followers to chip in. That is
the pattern that worked for her.
`.trim();

describe('validateCopy', () => {
  it('returns failed for empty input', () => {
    const r = validateCopy('');
    expect(r.passed).toBe(false);
    expect(r.issues[0]?.type).toBe('empty');
    expect(r.wordCount).toBe(0);
  });

  it('passes a clean baseline body', () => {
    const r = validateCopy(PASSING_BODY);
    expect(r.passed).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.wordCount).toBeGreaterThan(60);
  });

  it('flags "not just X but Y" pivots', () => {
    const r = validateCopy('They are not just a bakery, but a community space.');
    expect(r.issues.some((i) => i.type === 'not_just_but')).toBe(true);
  });

  it('flags "not only X but also Y"', () => {
    const r = validateCopy('Honeycomb is not only a lender, but also a launchpad.');
    expect(r.issues.some((i) => i.type === 'not_just_but')).toBe(true);
  });

  it('flags hedge phrases', () => {
    const r = validateCopy("It's worth noting that the campaign closed early.");
    expect(r.issues.some((i) => i.type === 'hedge_phrase')).toBe(true);
  });

  it('flags "in today’s landscape" with curly apostrophe', () => {
    const r = validateCopy('In today’s landscape, small businesses face new pressures.');
    expect(r.issues.some((i) => i.type === 'hedge_phrase')).toBe(true);
  });

  it('flags AI vocabulary like "delve" and "tapestry"', () => {
    const r = validateCopy('She delves into the rich tapestry of small-business finance.');
    expect(r.issues.some((i) => i.type === 'ai_vocab')).toBe(true);
  });

  it('flags generic openers at the start', () => {
    const r = validateCopy('In the world of small business, capital is the bottleneck. ' + PASSING_BODY);
    expect(r.issues.some((i) => i.type === 'generic_opener')).toBe(true);
  });

  it('does NOT flag the same opener mid-paragraph', () => {
    const r = validateCopy('Sarah grew up baking. In the world of small business, that matters less than people think.');
    // generic_opener only matches at start
    expect(r.issues.some((i) => i.type === 'generic_opener')).toBe(false);
  });

  it('flags em-dash overuse above density threshold', () => {
    const overused = 'one—two—three—four—five word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word';
    const r = validateCopy(overused);
    expect(r.issues.some((i) => i.type === 'em_dash_overuse')).toBe(true);
  });

  it('does NOT flag a few em-dashes in a long body', () => {
    const r = validateCopy(PASSING_BODY + ' One — carefully placed — dash.');
    expect(r.issues.some((i) => i.type === 'em_dash_overuse')).toBe(false);
  });

  it('flags tricolon density above threshold', () => {
    const tricolons =
      'fast, cheap, and easy. red, white, and blue. up, down, and sideways. north, south, and east. ' +
      'one two three four five six seven eight nine ten';
    const r = validateCopy(tricolons);
    expect(r.issues.some((i) => i.type === 'tricolon_list')).toBe(true);
  });

  it('does NOT flag a single tricolon in a long body', () => {
    const r = validateCopy(PASSING_BODY + ' She raises bread, soup, and broth.');
    expect(r.issues.some((i) => i.type === 'tricolon_list')).toBe(false);
  });
});

describe('stripHtml', () => {
  it('removes tags and decodes entities', () => {
    expect(stripHtml('<p>hello&nbsp;world &amp; bees</p>')).toBe('hello world & bees');
  });
  it('handles null/empty input', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
    expect(stripHtml('')).toBe('');
  });
  it('collapses whitespace', () => {
    expect(stripHtml('<p>a</p>\n\n<p>b</p>')).toBe('a b');
  });
});

describe('applyPromptSubstitutions', () => {
  // Guards against adding `{{HUMANIZATION_FOO}}` to the prompt without
  // adding a matching entry to PromptSubstitutions. An unfilled placeholder
  // would silently leak into the system prompt sent to Claude.
  it('substitutes every {{HUMANIZATION_*}} placeholder in the runtime prompt', async () => {
    const promptPath = path.resolve(process.cwd(), 'prompts/case-study-prompt.md');
    const raw = await fs.readFile(promptPath, 'utf8');
    const substituted = applyPromptSubstitutions(raw);
    expect(substituted).not.toMatch(/\{\{HUMANIZATION_/);
  });
});

describe('formatIssuesForReviewer', () => {
  it('returns empty string for no issues', () => {
    expect(formatIssuesForReviewer([])).toBe('');
  });
  it('formats a single issue with examples', () => {
    const out = formatIssuesForReviewer([
      { type: 'ai_vocab', message: 'Swap for plainer language.', count: 2, examples: ['delve', 'tapestry'] },
    ]);
    expect(out).toContain('[ai_vocab]');
    expect(out).toContain('Found 2 occurrence(s).');
    expect(out).toContain('"delve"');
  });
  it('formats density issues with per-500 metric', () => {
    const out = formatIssuesForReviewer([
      { type: 'em_dash_overuse', message: 'Overused.', count: 5, per500Words: 8.2 },
    ]);
    expect(out).toContain('Density: 8.2 per 500 words.');
  });
});

// Pins parseSlugs() behavior against the failure mode that wasted one
// rate-limit token on issue #26: the Issue Form's `render: text` slug
// textarea wraps user content in a markdown code fence, and the parser
// was treating the fence delimiters as if they were slugs.

import { describe, expect, it } from 'vitest';
import { parseSlugs } from './parse-slugs.js';

describe('parseSlugs', () => {
  it('parses a clean newline-separated slug list', () => {
    expect(parseSlugs('Slutty-Vegan\nThe-Onion-Tree\nBareSol-Spice-Co')).toEqual([
      'Slutty-Vegan',
      'The-Onion-Tree',
      'BareSol-Spice-Co',
    ]);
  });

  it('strips empty lines and surrounding whitespace', () => {
    expect(parseSlugs('  Slutty-Vegan  \n\n  The-Onion-Tree\n')).toEqual([
      'Slutty-Vegan',
      'The-Onion-Tree',
    ]);
  });

  it('skips comment lines', () => {
    expect(parseSlugs('# header\nSlutty-Vegan\n# another\nThe-Onion-Tree')).toEqual([
      'Slutty-Vegan',
      'The-Onion-Tree',
    ]);
    expect(parseSlugs('// js-style comment\nSlutty-Vegan')).toEqual(['Slutty-Vegan']);
  });

  it('strips markdown code-fence markers (issue #26 regression)', () => {
    // Real input shape from a `render: text` Issue Form textarea —
    // GitHub wraps the user-entered slugs in a fenced block.
    const raw = '```text\nSlutty-Vegan\nThe-Onion-Tree\nBareSol-Spice-Co\nSteele-Hair-Gallery\nRogues-Over-the-Top-Pierogi\n```';
    expect(parseSlugs(raw)).toEqual([
      'Slutty-Vegan',
      'The-Onion-Tree',
      'BareSol-Spice-Co',
      'Steele-Hair-Gallery',
      'Rogues-Over-the-Top-Pierogi',
    ]);
  });

  it('also strips bare ```text and ``` lines', () => {
    expect(parseSlugs('```\nSlutty-Vegan\n```text\nThe-Onion-Tree\n```')).toEqual([
      'Slutty-Vegan',
      'The-Onion-Tree',
    ]);
  });

  it('hard-rejects anything that does not match VALID_SLUG_RE', () => {
    // URLs, paths, weird characters — none would resolve at /campaigns/<slug>
    expect(parseSlugs('https://invest.honeycombcredit.com/campaigns/Foo')).toEqual([]);
    expect(parseSlugs('Foo Bar')).toEqual([]); // space
    expect(parseSlugs('Foo/Bar')).toEqual([]); // slash
    expect(parseSlugs('Foo\\Bar')).toEqual([]); // backslash
    expect(parseSlugs('-Foo')).toEqual([]); // leading hyphen (must start alphanumeric)
  });

  it('accepts the actual slug shapes seen in the wild', () => {
    expect(parseSlugs('The-Saucy-African')).toEqual(['The-Saucy-African']);
    expect(parseSlugs('Rogues-Over-the-Top-Pierogi')).toEqual(['Rogues-Over-the-Top-Pierogi']);
    expect(parseSlugs('BareSol-Spice-Co')).toEqual(['BareSol-Spice-Co']);
    expect(parseSlugs('campaign_with_underscores')).toEqual(['campaign_with_underscores']);
  });

  it('handles empty input', () => {
    expect(parseSlugs(undefined)).toEqual([]);
    expect(parseSlugs('')).toEqual([]);
    expect(parseSlugs('\n\n\n')).toEqual([]);
  });

  it('handles comma-separated input alongside newlines', () => {
    expect(parseSlugs('Slutty-Vegan, The-Onion-Tree, BareSol-Spice-Co')).toEqual([
      'Slutty-Vegan',
      'The-Onion-Tree',
      'BareSol-Spice-Co',
    ]);
    expect(parseSlugs('Slutty-Vegan,\nThe-Onion-Tree')).toEqual([
      'Slutty-Vegan',
      'The-Onion-Tree',
    ]);
  });
});

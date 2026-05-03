// Parses the slugs textarea from the Backfill Issue Form into a clean
// list of Honeycomb campaign slugs. Defends against:
//
//   - empty lines, surrounding whitespace
//   - comment lines (`#` or `//`)
//   - markdown code-fence delimiters that the form's `render: text`
//     textarea wraps the user input in (issue #26 regression)
//   - URLs, paths, or anything else that wouldn't resolve at
//     invest.honeycombcredit.com/campaigns/<slug>
//
// Honeycomb campaign slugs are URL path components — alphanumeric with
// hyphens (and occasionally underscores), starting with an alphanumeric
// character. This regex is intentionally conservative.

const VALID_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function parseSlugs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter((s) => {
      if (s.length === 0) return false;
      if (s.startsWith('#')) return false;     // user comment line
      if (s.startsWith('```')) return false;   // markdown code-fence delimiter
      if (s.startsWith('//')) return false;    // alt comment style
      return VALID_SLUG_RE.test(s);            // hard-reject non-slug shapes
    });
}

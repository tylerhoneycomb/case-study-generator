// Tiny argv parser for the CLI scripts. Avoids pulling in commander/yargs.
// Supports:
//   - positional args
//   - --flag (boolean)
//   - --key=value or --key value (string)
//
// Each CLI calls parseArgs(process.argv.slice(2)) and reads what it needs.

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, boolean>;
  values: Record<string, string>;
}

export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, boolean> = {};
  const values: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok) continue;
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq !== -1) {
        const k = tok.slice(2, eq);
        values[k] = tok.slice(eq + 1);
      } else {
        const k = tok.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          values[k] = next;
          i++;
        } else {
          flags[k] = true;
        }
      }
    } else {
      positional.push(tok);
    }
  }

  return { positional, flags, values };
}

export function requirePositional(args: ParsedArgs, idx: number, name: string): string {
  const v = args.positional[idx];
  if (!v) {
    console.error(`Missing required positional arg: ${name}`);
    process.exit(2);
  }
  return v;
}

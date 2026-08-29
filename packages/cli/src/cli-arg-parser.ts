export type ParsedCliArgs = {
  values: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
};

export type CliArgParserOptions = {
  command: string;
  valueFlags: readonly string[];
  booleanFlags: readonly string[];
  allowPositionals?: boolean;
};

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j += 1) {
      current.push(
        left[i] === right[j]
          ? previous[j]!
          : 1 + Math.min(previous[j]!, previous[j + 1]!, current[j]!),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

/** Levenshtein "Did you mean" over the command's declared flags, mirroring closestCommand. */
function closestFlag(input: string, known: readonly string[]): string | undefined {
  let best: { flag: string; distance: number } | undefined;
  for (const flag of known) {
    const distance = editDistance(input, flag);
    if (distance <= 2 && (!best || distance < best.distance)) best = { flag, distance };
  }
  return best?.flag;
}

function unknownOptionError(command: string, argument: string, known: readonly string[]): Error {
  const name = argument.replace(/^--?/, '');
  const suggestion = closestFlag(name, known);
  const available = known.map((flag) => `--${flag}`).join(', ');
  const hint = suggestion
    ? ` Did you mean --${suggestion}?`
    : ` Available ${command} options: ${available}.`;
  return new Error(
    `Unknown ${command} option: ${argument}.${hint} Run "rustra ${command} --help".`,
  );
}

/** Shared long-option parser used by every CLI subcommand. */
export function parseCliArgs(args: readonly string[], options: CliArgParserOptions): ParsedCliArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  const valueFlags = new Set(options.valueFlags);
  const booleanFlags = new Set(options.booleanFlags);
  const known = [...options.valueFlags, ...options.booleanFlags];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '-h' && booleanFlags.has('h')) {
      flags.add('h');
      continue;
    }
    if (!argument.startsWith('--')) {
      if (!options.allowPositionals) {
        throw unknownOptionError(options.command, argument, known);
      }
      positionals.push(argument);
      continue;
    }

    const [name, inlineValue] = argument.slice(2).split('=', 2);
    if (booleanFlags.has(name!)) {
      if (inlineValue !== undefined) {
        throw new Error(`--${name} does not accept a value`);
      }
      flags.add(name!);
      continue;
    }
    if (!valueFlags.has(name!)) throw unknownOptionError(options.command, argument, known);
    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    values.set(name!, value);
  }

  return { values, flags, positionals };
}

export function requiredCliValue(parsed: ParsedCliArgs, name: string): string {
  const value = parsed.values.get(name);
  if (!value) throw new Error(`--${name} requires a value`);
  return value;
}

export function cliFormat(value: string | undefined, command: string): 'text' | 'json' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'text' && value !== 'json') {
    throw new Error(`${command} --format must be text or json`);
  }
  return value;
}

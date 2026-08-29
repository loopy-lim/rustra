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

/** Shared long-option parser used by every CLI subcommand. */
export function parseCliArgs(args: readonly string[], options: CliArgParserOptions): ParsedCliArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  const valueFlags = new Set(options.valueFlags);
  const booleanFlags = new Set(options.booleanFlags);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '-h' && booleanFlags.has('h')) {
      flags.add('h');
      continue;
    }
    if (!argument.startsWith('--')) {
      if (!options.allowPositionals) {
        throw new Error(`Unknown ${options.command} option: ${argument}`);
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
    if (!valueFlags.has(name!)) throw new Error(`Unknown ${options.command} option: ${argument}`);
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

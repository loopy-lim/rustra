import { closestMatch } from './cli-suggest.js';
import { UsageError } from './cli-usage-error.js';

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

/** Levenshtein "Did you mean" over the command's declared flags (case-sensitive). */
function closestFlag(input: string, known: readonly string[]): string | undefined {
  return closestMatch(input, known);
}

function unknownOptionError(
  command: string,
  argument: string,
  known: readonly string[],
): UsageError {
  const name = argument.replace(/^--?/, '');
  const suggestion = closestFlag(name, known);
  const available = known.map((flag) => `--${flag}`).join(', ');
  const hint = suggestion
    ? ` Did you mean --${suggestion}?`
    : ` Available ${command} options: ${available}.`;
  return new UsageError(
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
    // help 관례 단일화 — -h 는 어느 커맨드에서든 help 로 정규화한다. 출력은
    // cli-main 이 담당하고 파서는 플래그만 채우므로, 소비자는 flags.has('help')
    // (또는 options.help) 하나만 본다. h 를 별도 플래그로 선언·판별하는 이중
    // 관례는 남지 않는다.
    if (argument === '-h') {
      flags.add('help');
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
        throw new UsageError(`--${name} does not accept a value`);
      }
      flags.add(name!);
      continue;
    }
    if (!valueFlags.has(name!)) throw unknownOptionError(options.command, argument, known);
    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith('--')) throw new UsageError(`--${name} requires a value`);
    values.set(name!, value);
  }

  return { values, flags, positionals };
}

export function cliFormat(value: string | undefined, command: string): 'text' | 'json' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'text' && value !== 'json') {
    throw new UsageError(`${command} --format must be text or json`);
  }
  return value;
}

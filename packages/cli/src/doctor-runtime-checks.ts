import type {
  DoctorCheck,
  DoctorCommandResult,
  DoctorConfig,
  DoctorRunner,
} from './doctor-types.js';
import { isVersionAtLeast } from './doctor-types.js';
import { conditionalCheck } from './doctor-support.js';

function supported(result: DoctorCommandResult, minimum: [number, number, number]): boolean {
  const version = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]*)?$/m.exec(result.stdout.trim());
  return Boolean(
    result.ok &&
    version &&
    isVersionAtLeast([Number(version[1]), Number(version[2]), Number(version[3])], minimum),
  );
}

/** Node's process adapter also runs on Bun; generated Bun FFI requires Bun. */
export function collectJavaScriptRuntimeChecks(
  runner: DoctorRunner,
  config?: DoctorConfig,
): DoctorCheck[] {
  const node = runner('node', ['--version']);
  const bun = runner('bun', ['--version']);
  const nodeSupported = supported(node, [18, 0, 0]);
  const bunSupported = supported(bun, [1, 4, 0]);
  const detail = (name: string, result: DoctorCommandResult) =>
    `${name}: ${result.stdout.trim() || result.stderr.trim() || result.error || 'unavailable'}`;
  const checks = [
    conditionalCheck(
      'js.runtime',
      true,
      nodeSupported || bunSupported,
      nodeSupported ? 'Node.js 18+ is available' : 'Bun 1.4+ is available',
      'Node.js 18+ or Bun 1.4+ is required',
      `${detail('Node.js', node)}; ${detail('Bun', bun)}`,
      ['Install Node.js 18+ or Bun 1.4+'],
    ),
  ];
  if (config?.node)
    checks.push(
      conditionalCheck(
        'node.runtime',
        true,
        nodeSupported || bunSupported,
        nodeSupported
          ? 'Node.js 18+ is available for the Node adapter'
          : 'Bun 1.4+ is available for the Node adapter',
        'The configured Node adapter requires Node.js 18+ or Bun 1.4+',
        `${detail('Node.js', node)}; ${detail('Bun', bun)}`,
        ['Install Node.js 18+ or Bun 1.4+ and ensure the runtime is on PATH'],
      ),
    );
  if (config?.bun)
    checks.push(
      conditionalCheck(
        'bun.runtime',
        true,
        bunSupported,
        'Bun 1.4+ is available for the Bun host',
        'The configured Bun host requires Bun 1.4+',
        detail('Bun', bun),
        ['Install Bun 1.4+ and ensure bun is on PATH'],
      ),
    );
  return checks;
}

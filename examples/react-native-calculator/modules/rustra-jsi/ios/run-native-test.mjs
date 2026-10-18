// Bound Simulator/ASan startup as well as test execution; never hang CI before main.
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const expectAsan = args[0] === '--expect-asan';
if (expectAsan) args.shift();
const [command, ...argv] = args;
if (!command) throw new Error('native test command required');
const timeout = Number(process.env.RUSTRA_NATIVE_TEST_TIMEOUT_MS ?? 120000);
if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('invalid native timeout');
const result = spawnSync(command, argv, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error)
  throw new Error(`native test failed: ${result.error.message}`, { cause: result.error });
if (expectAsan) {
  if (
    result.status === 0 ||
    !/ERROR: AddressSanitizer: heap-use-after-free/.test(result.stderr ?? '')
  )
    throw new Error('ASan canary did not detect the intentional use-after-free');
  console.log('ASan canary detected heap-use-after-free');
} else if (result.status !== 0) {
  throw new Error(`native test exited ${result.status}, signal ${result.signal}`);
}

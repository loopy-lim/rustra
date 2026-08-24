import { describe, expect, test } from 'bun:test';
import {
  analyzeAutolinking,
  analyzeGeneratedArtifacts,
  analyzeInstalledBinary,
  analyzeRustArchive,
  compareSemanticVersions,
  formatDoctorReport,
  parseArguments,
} from './doctor.mjs';
import {
  buildInputFiles,
  computeBuildFingerprint,
  renderBuildFingerprint,
} from './generate-build-fingerprint.mjs';

const REQUIRED_SYMBOLS = `
000 T _rustra_mobile_init
000 T _rustra_ffi_invoke_buffer
000 T _rustra_ffi_has_buffer
000 T _rustra_ffi_invoke_raw
000 T _rustra_ffi_has_raw
000 T _rustra_ffi_free_owned_bytes
000 T _rustra_ffi_invoke_rkyv_v2_async
000 T _rustra_calculator_invoke_rkyv_v2
000 T _rustra_calculator_invoke_typed_raw
000 T _rustra_calculator_free_rkyv_v2_buffer
`;

describe('RN doctor', () => {
  test('parses Bun semantic versions and arguments without guessing unknown flags', () => {
    expect(compareSemanticVersions('1.4.0', '1.4.0')).toBe(0);
    expect(compareSemanticVersions('1.4.1-canary.1', '1.4.0')).toBe(1);
    expect(compareSemanticVersions('1.3.9', '1.4.0')).toBe(-1);
    expect(compareSemanticVersions('not-a-version', '1.4.0')).toBeUndefined();

    expect(parseArguments(['--json', '--device', 'sim-1'])).toMatchObject({
      json: true,
      device: 'sim-1',
      bundleId: 'com.alt-shifted.react-native-calculator',
    });
    expect(() => parseArguments(['--fix'])).toThrow('unknown option');
  });

  test('hashes build input content without self-reference or test-only files', async () => {
    const files = await buildInputFiles();
    expect(files.some((path) => path.endsWith('/src/build-fingerprint.ts'))).toBe(false);
    expect(files.some((path) => path.endsWith('.test.ts'))).toBe(false);
    const result = await computeBuildFingerprint();
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.inputCount).toBe(files.length);
    expect(renderBuildFingerprint(result)).toContain(result.fingerprint);
  });

  test('pins Rust schema, generated TypeScript, and native command ids together', () => {
    const schemaSource = JSON.stringify({
      commands: [
        { name: 'addNumbers', commandId: 1 },
        { name: 'echoBytes', commandId: 25 },
      ],
    });
    const hash = new Bun.CryptoHasher('sha256').update(schemaSource).digest('hex');
    const results = analyzeGeneratedArtifacts({
      schemaSource,
      contractSource: `export const GENERATED_CONTRACT_HASH = '${hash}';`,
      commandsSource: 'export const addNumbers = 1;\nexport const echoBytes = 2;',
      cppSource:
        'if (name == "addNumbers") {}\ncase 1: return;\n' +
        'if (name == "echoBytes") {}\ncase 25: return;',
    });

    expect(results.every((result) => result.status === 'pass')).toBe(true);

    const stale = analyzeGeneratedArtifacts({
      schemaSource,
      contractSource: `export const GENERATED_CONTRACT_HASH = '${'0'.repeat(64)}';`,
      commandsSource: 'export const addNumbers = 1;',
      cppSource: 'if (name == "addNumbers") {}\ncase 1: return;',
    });
    expect(stale.filter((result) => result.status === 'fail').map((result) => result.id)).toEqual([
      'generated.contract',
      'generated.commands',
      'native.codecs',
    ]);
    expect(stale.find((result) => result.id === 'native.codecs')?.fix).toContain(
      'bun run test:cpp-codec',
    );
  });

  test('distinguishes stale Rust, ABI symbols, and simulator architectures', () => {
    const passing = analyzeRustArchive({
      exists: true,
      archiveMtimeMs: 2,
      newestSourceMtimeMs: 1,
      newestSourcePath: 'examples/calculator/src/lib.rs',
      symbols: REQUIRED_SYMBOLS,
      architectures: 'Architectures in the fat file are: x86_64 arm64',
    });
    expect(passing.every((result) => result.status === 'pass')).toBe(true);

    const broken = analyzeRustArchive({
      exists: true,
      archiveMtimeMs: 1,
      newestSourceMtimeMs: 2,
      newestSourcePath: 'crates/rustra/src/ffi.rs',
      symbols: '_rustra_ffi_invoke_buffer',
      architectures: 'arm64',
    });
    expect(broken.map((result) => result.id)).toEqual([
      'rust.archive.freshness',
      'rust.archive.symbols',
      'rust.archive.architectures',
    ]);
    expect(broken.every((result) => result.status === 'fail')).toBe(true);
    expect(broken[0].fix).toContain('JS reload cannot replace stale Rust symbols');
  });

  test('rejects an installed app that predates the current archive or drops linked symbols', () => {
    const current = analyzeInstalledBinary({
      binaryMtimeMs: 2,
      newestInputMtimeMs: 1,
      newestInputPath: 'archive.a',
      symbols: REQUIRED_SYMBOLS,
    });
    expect(current.every((result) => result.status === 'pass')).toBe(true);

    const stale = analyzeInstalledBinary({
      binaryMtimeMs: 1,
      newestInputMtimeMs: 2,
      newestInputPath: 'modules/rustra-jsi/ios/rust/lib/librustra_calculator_example.a',
      symbols: '_rustra_ffi_invoke_buffer',
    });
    expect(stale.map((result) => result.id)).toEqual(['ios.app.freshness', 'ios.app.symbols']);
    expect(stale.every((result) => result.status === 'fail')).toBe(true);
    expect(stale[0].fix).toContain('already installed app');
  });

  test('renders actionable hints and machine-readable stable ids', () => {
    const report = {
      app: 'example',
      appRoot: '/tmp/example',
      checks: [
        {
          status: 'fail',
          layer: 'Rust',
          id: 'rust.archive',
          summary: 'archive missing',
          details: 'no file',
          fix: 'Run `bun run rust:ios`.',
        },
      ],
      summary: { pass: 0, warn: 0, fail: 1 },
    };
    const output = formatDoctorReport(report);
    expect(output).toContain('FAIL [Rust] archive missing');
    expect(output).toContain('fix: Run `bun run rust:ios`.');
    expect(output).toContain('doctor is read-only');
  });

  test('requires one generated module to autolink on bare RN iOS and Android', () => {
    const reactNativeConfig = JSON.stringify({
      dependencies: {
        '@rustra/generated-react-native': {
          platforms: {
            ios: { podspecPath: '/app/modules/rustra-bridge/RustraBridge.podspec' },
            android: { sourceDir: '/app/modules/rustra-bridge/android' },
          },
        },
      },
    });
    const pods = ['RustraBridge', 'RustraCalculator', 'NitroBench']
      .map((name) => `  - ${name} (0.0.0):`)
      .join('\n');
    expect(
      analyzeAutolinking({ reactNativeConfig, podfileLock: pods }).every(
        (result) => result.status === 'pass',
      ),
    ).toBe(true);
    expect(
      analyzeAutolinking({ reactNativeConfig: '{}', podfileLock: '' })
        .filter((result) => result.status === 'fail')
        .map((result) => result.id),
    ).toEqual(['native.autolinking.config', 'ios.pods.locked']);
  });
});

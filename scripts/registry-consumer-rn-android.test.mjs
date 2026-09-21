import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertJourneyObservation,
  assertMutatedObservation,
  mutateRnLibRs,
  parseLogcatMarker,
  renderJourneyInputTs,
  renderMetroConfigJs,
  renderRnAppTsx,
  renderRnCargoToml,
  renderRnConfigJson,
  renderRnLibRs,
} from './registry-consumer-rn-android.mjs';
import { assertNoConsumerContamination } from './registry-consumer/provenance.mjs';

const JOURNEY_MARKER = '__RUSTRA_RN_JOURNEY__';

function validObservation(overrides = {}) {
  return {
    phase: 'baseline',
    echoResult: { message: 'registry-rn' },
    failEchoError: {
      code: 'command.invalid_args',
      message: 'registry rn journey error propagation',
    },
    ...overrides,
  };
}

test('rendered RN lib.rs mutates exactly once and ends with native_entry', () => {
  const baseline = renderRnLibRs();
  assert.match(baseline, /rustra::native_entry!\(package\);/);
  const mutated = mutateRnLibRs(baseline);
  assert.match(mutated, /pub repeat: u32/);
  assert.throws(() => mutateRnLibRs(mutated), /anchor not found/);
});

test('RN journey observation assertions mirror the bridge contract', () => {
  assert.equal(assertJourneyObservation(validObservation()), true);
  assert.throws(
    () => assertJourneyObservation(validObservation({ failEchoError: null })),
    /did not reject/,
  );
  assert.throws(
    () =>
      assertJourneyObservation(
        validObservation({ failEchoError: { code: null, message: 'different' } }),
      ),
    /cross the JSI bridge intact/,
  );
  assert.throws(
    () => assertJourneyObservation(validObservation({ journeyError: 'install failed' })),
    /install failed/,
  );
  assert.equal(
    assertMutatedObservation(
      validObservation({ phase: 'mutated', echoResult: { message: 'registry-rn', repeat: 3 } }),
    ),
    true,
  );
  assert.throws(
    () => assertMutatedObservation(validObservation({ phase: 'mutated' })),
    /repeat=3/,
  );
});

test('logcat marker parsing keeps only complete JSON for the requested phase', () => {
  const good = JSON.stringify(validObservation({ phase: 'mutated' }));
  const logcat = [
    '09-21 10:00:00.000 I/ReactNativeJS( 1234): booting',
    `09-21 10:00:01.000 I/ReactNativeJS( 1234): ${JOURNEY_MARKER}${good}`,
    `09-21 10:00:01.100 I/ReactNativeJS( 1234): ${JOURNEY_MARKER}${good.slice(0, 40)}`,
  ].join('\n');
  const parsed = parseLogcatMarker(logcat, 'mutated');
  assert.equal(parsed.echoResult.message, 'registry-rn');
  assert.equal(parseLogcatMarker(logcat, 'baseline'), null);
});

test('metro config strips .js specifiers before the default resolver', () => {
  const metro = renderMetroConfigJs();
  assert.match(metro, /moduleName\.endsWith\('\.js'\)/);
  assert.match(metro, /getDefaultConfig/);
});

test('renderers keep deterministic anchors for the RN journey', () => {
  assert.match(renderRnAppTsx(), /generated\/react-native\.js/);
  assert.match(renderRnAppTsx(), new RegExp(JOURNEY_MARKER));
  assert.doesNotMatch(renderRnAppTsx(), /subscribeEvent/);
  assert.match(renderJourneyInputTs({ phase: 'mutated', repeat: 3 }), /repeat: 3/);
  const config = JSON.parse(renderRnConfigJson());
  assert.equal(config.reactNative.rustManifest, './Cargo.toml');
  assert.match(renderRnCargoToml(), /crate-type = \["rlib", "staticlib"\]/);
});

test('contamination scan allows only the declared generated workspace package', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-contamination-'));
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        private: true,
        dependencies: {
          '@rustra/generated-react-native': 'workspace:*',
          '@rustra/react-native': '0.9.2',
        },
        workspaces: ['modules/rustra-bridge'],
      }),
    );
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname="x"\n');
    assert.doesNotThrow(() =>
      assertNoConsumerContamination(root, {
        expectedNpm: { '@rustra/react-native': '0.9.2' },
        allowedWorkspacePackages: ['@rustra/generated-react-native'],
      }),
    );
    assert.throws(
      () =>
        assertNoConsumerContamination(root, {
          expectedNpm: { '@rustra/react-native': '0.9.2' },
          allowedWorkspacePackages: [],
        }),
      /forbidden dependency source workspace:\*/,
    );
    // 다른 패키지의 workspace:* 는 허용 목록에 있어도 통과하지 않는다.
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    manifest.dependencies['@rustra/types'] = 'workspace:*';
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    assert.throws(
      () =>
        assertNoConsumerContamination(root, {
          expectedNpm: { '@rustra/react-native': '0.9.2' },
          allowedWorkspacePackages: ['@rustra/generated-react-native'],
        }),
      /forbidden dependency source workspace:\*/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

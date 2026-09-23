import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  assertJourneyObservation,
  assertMutatedObservation,
  mutateTauriLibRs,
  parseEvidenceLine,
  renderJourneyInputTs,
  renderTauriAppTs,
  renderTauriCapabilities,
  renderTauriConfJson,
  renderTauriLibRs,
} from './registry-consumer-tauri.mjs';
import { validateVersionManifest } from './registry-consumer/provenance.mjs';

const VERSIONS_PATH = fileURLToPath(new URL('./registry-consumer/versions.json', import.meta.url));

function validObservation(overrides = {}) {
  return {
    phase: 'baseline',
    userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/620.1.15 Safari/620.1.15',
    hasTauriGlobal: true,
    echoResult: { message: 'registry-tauri' },
    failEchoError: {
      code: 'command.invalid_args',
      message: 'registry tauri journey error propagation',
    },
    eventsBeforeUnsubscribe: 3,
    eventsAfterUnsubscribe: 0,
    firstEmitted: 3,
    secondEmitted: 2,
    ...overrides,
  };
}

test('versions.json admits the tauri host pin and stays a valid manifest', () => {
  const manifest = validateVersionManifest(JSON.parse(readFileSync(VERSIONS_PATH, 'utf8')));
  assert.equal(manifest.hosts['@rustra/tauri'], '0.9.3');
});

test('validateVersionManifest rejects unknown host keys', () => {
  const manifest = JSON.parse(readFileSync(VERSIONS_PATH, 'utf8'));
  manifest.hosts = { '@rustra/electron': '1.0.0' };
  assert.throws(() => validateVersionManifest(manifest), /unknown key/);
});

test('validateVersionManifest rejects non-exact host pins', () => {
  const manifest = JSON.parse(readFileSync(VERSIONS_PATH, 'utf8'));
  manifest.hosts = { '@rustra/tauri': '^0.9.3' };
  assert.throws(() => validateVersionManifest(manifest), /hosts\.@rustra\/tauri/);
});

test('rendered lib.rs mutates exactly once and rejects double mutation', () => {
  const baseline = renderTauriLibRs();
  const mutated = mutateTauriLibRs(baseline);
  assert.match(mutated, /pub repeat: u32/);
  assert.doesNotMatch(baseline, /pub repeat: u32/);
  assert.throws(() => mutateTauriLibRs(mutated), /anchor not found/);
});

test('journey observation assertions verify webview evidence strictly', () => {
  assert.equal(assertJourneyObservation(validObservation()), true);
  assert.throws(
    () => assertJourneyObservation(validObservation({ userAgent: 'node' })),
    /real WebKit view/,
  );
  assert.throws(
    () => assertJourneyObservation(validObservation({ hasTauriGlobal: false })),
    /__TAURI__/,
  );
  assert.throws(
    () => assertJourneyObservation(validObservation({ failEchoError: null })),
    /did not reject/,
  );
  assert.throws(
    () => assertJourneyObservation(validObservation({ eventsAfterUnsubscribe: 2 })),
    /after unsubscribe/,
  );
});

test('mutated observation additionally requires repeat=3 from the changed field', () => {
  assert.equal(
    assertMutatedObservation(validObservation({ phase: 'mutated', echoResult: { message: 'registry-tauri', repeat: 3 } })),
    true,
  );
  assert.throws(
    () =>
      assertMutatedObservation(
        validObservation({ phase: 'mutated', echoResult: { message: 'registry-tauri' } }),
      ),
    /repeat=3/,
  );
});

test('journey errors surfaced from the webview fail the assertion loudly', () => {
  assert.throws(
    () => assertJourneyObservation(validObservation({ journeyError: 'boom' })),
    /boom/,
  );
});

test('evidence lines parse as JSON and renderers keep deterministic anchors', () => {
  const input = renderJourneyInputTs({ phase: 'mutated', message: 'registry-tauri', repeat: 3 });
  assert.match(input, /repeat: 3/);
  const app = renderTauriAppTs();
  assert.match(app, /generated\/tauri\.js/);
  assert.match(app, /unsubscribe\(\)/);
  const conf = JSON.parse(renderTauriConfJson());
  assert.equal(conf.app.withGlobalTauri, true);
  assert.equal(conf.build.frontendDist, './dist');
  const capabilities = JSON.parse(renderTauriCapabilities());
  assert.deepEqual(capabilities.permissions, ['core:event:default']);
  assert.deepEqual(capabilities.windows, ['main']);
  const parsed = parseEvidenceLine('{"phase":"baseline"}');
  assert.equal(parsed.phase, 'baseline');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createConsumerManifest } from './check-packed-react-native-consumer.mjs';

test('pins the local types tarball for transitive 0.4.1 dependencies', () => {
  const manifest = createConsumerManifest({
    typesArchive: '/tmp/rustra-types-0.4.1.tgz',
    cliArchive: '/tmp/rustra-cli-0.4.1.tgz',
    reactNativeArchive: '/tmp/rustra-react-native-0.4.1.tgz',
  });

  assert.equal(manifest.dependencies['@rustra/types'], 'file:/tmp/rustra-types-0.4.1.tgz');
  assert.equal(manifest.overrides['@rustra/types'], 'file:/tmp/rustra-types-0.4.1.tgz');
});

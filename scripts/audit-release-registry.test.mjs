import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { auditRegistry, renderRegistryMarkdown } from './audit-release-registry.mjs';

function rootFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rustra-registry-audit-'));
  mkdirSync(join(root, 'packages', 'node'), { recursive: true });
  mkdirSync(join(root, 'crates', 'rustra'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'node', 'package.json'),
    JSON.stringify({ name: '@rustra/node', version: '1.2.3' }),
  );
  writeFileSync(
    join(root, 'Cargo.toml'),
    '[workspace]\nmembers = ["crates/rustra"]\n[workspace.package]\nversion = "2.3.4"\n',
  );
  writeFileSync(
    join(root, 'crates', 'rustra', 'Cargo.toml'),
    '[package]\nname = "rustra"\nversion.workspace = true\n',
  );
  return root;
}

function tarEntry(name, content) {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name);
  header.write('0000777\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.fill(0x20, 148, 156);
  header.write('0', 156);
  header.write('ustar\0', 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function crateArchive(name, version, sha, dirty = false) {
  return gzipSync(
    Buffer.concat([
      tarEntry(
        `${name}-${version}/.cargo_vcs_info.json`,
        JSON.stringify({ git: { sha1: sha, dirty }, path_in_vcs: '' }),
      ),
      Buffer.alloc(1024),
    ]),
  );
}

function response(status, body, headers = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://registry.example.test/final',
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(bytes.toString()),
    text: async () => bytes.toString(),
    arrayBuffer: async () => bytes,
  };
}

function fixtures({ npm, index, archive, throwOn } = {}) {
  return async (url) => {
    if (throwOn && String(url).includes(throwOn)) throw new Error('offline');
    if (String(url).startsWith('https://registry.npmjs.org/')) return npm;
    if (String(url).startsWith('https://index.crates.io/')) return index;
    if (String(url).startsWith('https://static.crates.io/')) return archive;
    throw new Error(`unexpected URL ${url}`);
  };
}

test('separates an unpublished npm exact version from a latest version with unknown source', async () => {
  const report = await auditRegistry({
    root: rootFixture(),
    candidate: { sha: 'candidate', dirty: false },
    fetchImpl: fixtures({
      npm: response(
        200,
        JSON.stringify({ 'dist-tags': { latest: '1.2.4' }, versions: { '1.2.4': { dist: {} } } }),
      ),
      index: response(404, ''),
    }),
  });
  assert.deepEqual(report.npm[0], {
    name: '@rustra/node',
    workspaceVersion: '1.2.3',
    exactVersion: null,
    latestVersion: '1.2.4',
    publication: 'unpublished',
    source: { revision: null, relation: 'unknown', dirty: null },
    registryUrl: 'https://registry.npmjs.org/%40rustra%2Fnode',
    dist: null,
    error: null,
  });
  assert.equal(report.errors.length, 0);
});

test('reports npm exact metadata and distinguishes matching and different gitHead', async () => {
  const candidateSha = 'a'.repeat(40);
  for (const [gitHead, relation] of [
    [candidateSha, 'exact'],
    ['b'.repeat(40), 'different'],
    [undefined, 'unknown'],
  ]) {
    const exact = {
      name: '@rustra/node',
      version: '1.2.3',
      gitHead,
      dist: {
        tarball: 'https://npm.test/pkg.tgz',
        shasum: 'a'.repeat(40),
        integrity: 'sha512-eA==',
      },
    };
    const report = await auditRegistry({
      root: rootFixture(),
      candidate: { sha: candidateSha, dirty: true },
      fetchImpl: fixtures({
        npm: response(
          200,
          JSON.stringify({ 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': exact } }),
        ),
        index: response(404, ''),
      }),
    });
    assert.equal(report.npm[0].source.relation, relation);
    assert.deepEqual(report.npm[0].dist, exact.dist);
    assert.equal(report.candidate.dirty, true);
  }
});

test('verifies crate checksum before reading VCS metadata from the in-memory archive', async () => {
  const candidateSha = 'a'.repeat(40);
  const archive = crateArchive('rustra', '2.3.4', candidateSha);
  const checksum = createHash('sha256').update(archive).digest('hex');
  const index = [
    JSON.stringify({ name: 'rustra', vers: '2.3.4', cksum: checksum, yanked: false }),
    JSON.stringify({ name: 'rustra', vers: '2.4.0', cksum: 'f'.repeat(64), yanked: false }),
  ].join('\n');
  const report = await auditRegistry({
    root: rootFixture(),
    candidate: { sha: candidateSha, dirty: false },
    fetchImpl: fixtures({
      npm: response(404, ''),
      index: response(200, index),
      archive: response(200, archive),
    }),
  });
  assert.equal(report.crates[0].latestVersion, '2.4.0');
  assert.equal(report.crates[0].checksum.verified, true);
  assert.deepEqual(report.crates[0].source, {
    revision: candidateSha,
    relation: 'exact',
    dirty: false,
  });
  assert.equal(report.errors.length, 0);
});

test('makes checksum mismatch and network errors operational failures without guessing source', async () => {
  const archive = crateArchive('rustra', '2.3.4', 'a'.repeat(40));
  const index = JSON.stringify({
    name: 'rustra',
    vers: '2.3.4',
    cksum: 'd'.repeat(64),
    yanked: false,
  });
  const checksumReport = await auditRegistry({
    root: rootFixture(),
    candidate: { sha: 'candidate', dirty: false },
    fetchImpl: fixtures({
      npm: response(404, ''),
      index: response(200, index),
      archive: response(200, archive),
    }),
  });
  assert.equal(checksumReport.crates[0].checksum.verified, false);
  assert.equal(checksumReport.crates[0].source.relation, 'unknown');
  assert.match(checksumReport.errors[0].message, /checksum mismatch/);

  const networkReport = await auditRegistry({
    root: rootFixture(),
    candidate: { sha: 'candidate', dirty: false },
    fetchImpl: fixtures({ throwOn: 'registry.npmjs.org', index: response(404, '') }),
  });
  assert.equal(networkReport.npm[0].publication, 'query-error');
  assert.match(networkReport.npm[0].error, /offline/);
  assert.equal(networkReport.errors[0].kind, 'network');
});

test('hashes repeated local artifacts and renders evidence limits in Markdown', async () => {
  const root = rootFixture();
  const artifact = join(root, 'native.bin');
  writeFileSync(artifact, 'native bytes');
  const report = await auditRegistry({
    root,
    candidate: { sha: 'candidate', dirty: false },
    artifactPaths: [artifact],
    fetchImpl: fixtures({ npm: response(404, ''), index: response(404, '') }),
  });
  assert.equal(
    report.artifacts[0].sha256,
    'b0ca94ca54cf33f214f3bf9f31dddf9438ae1a42a93cb493454f741a1e6f024e',
  );
  const markdown = renderRegistryMarkdown(report);
  assert.match(markdown, /Local artifact evidence/);
  assert.match(markdown, /do not prove registry publication or physical-device runtime/i);
  assert.match(markdown, /@rustra\/node/);
});

test('rejects malformed npm metadata and exact package identity as query errors', async () => {
  for (const metadata of [
    {},
    { 'dist-tags': { latest: '1.2.3' }, versions: [] },
    {
      'dist-tags': { latest: '1.2.3' },
      versions: { '1.2.3': { name: '@rustra/other', version: '1.2.3', dist: {} } },
    },
    {
      'dist-tags': { latest: '1.2.3' },
      versions: { '1.2.3': { name: '@rustra/node', version: '9.9.9', dist: {} } },
    },
    { 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': null } },
    { 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': false } },
    {
      'dist-tags': { latest: '1.2.3' },
      versions: { '1.2.3': { name: '@rustra/node', version: '1.2.3', dist: [] } },
    },
    {
      'dist-tags': { latest: '1.2.3' },
      versions: { '1.2.3': { name: '@rustra/node', version: '1.2.3', dist: {} } },
    },
    {
      'dist-tags': { latest: '1.2.3' },
      versions: {
        '1.2.3': {
          name: '@rustra/node',
          version: '1.2.3',
          dist: { tarball: 'http://npm.test/pkg.tgz', shasum: 'a'.repeat(40) },
        },
      },
    },
    {
      'dist-tags': { latest: '1.2.3' },
      versions: {
        '1.2.3': {
          name: '@rustra/node',
          version: '1.2.3',
          dist: { tarball: 'https://npm.test/pkg.tgz', shasum: 'not-a-sha1' },
        },
      },
    },
  ]) {
    const report = await auditRegistry({
      root: rootFixture(),
      candidate: { sha: 'a'.repeat(40), dirty: false },
      fetchImpl: fixtures({
        npm: response(200, JSON.stringify(metadata)),
        index: response(404, ''),
      }),
    });
    assert.equal(report.npm[0].publication, 'query-error');
    assert.equal(report.errors[0].kind, 'registry');
  }
});

test('distinguishes an absent npm exact key from a present malformed value', async () => {
  const report = await auditRegistry({
    root: rootFixture(),
    candidate: { sha: 'a'.repeat(40), dirty: false },
    fetchImpl: fixtures({
      npm: response(200, JSON.stringify({ 'dist-tags': { latest: '1.2.4' }, versions: {} })),
      index: response(404, ''),
    }),
  });
  assert.equal(report.npm[0].publication, 'unpublished');
  assert.equal(report.errors.length, 0);
});

test('accepts only full hex revisions and does not claim exact source for a dirty crate archive', async () => {
  for (const [revision, dirty, relation] of [
    ['short', false, 'unknown'],
    ['g'.repeat(40), false, 'unknown'],
    ['a'.repeat(40), true, 'unknown'],
    ['a'.repeat(40), false, 'exact'],
  ]) {
    const archive = gzipSync(
      Buffer.concat([
        tarEntry(
          'rustra-2.3.4/.cargo_vcs_info.json',
          JSON.stringify({ git: { sha1: revision, dirty }, path_in_vcs: '' }),
        ),
        Buffer.alloc(1024),
      ]),
    );
    const checksum = createHash('sha256').update(archive).digest('hex');
    const index = JSON.stringify({ name: 'rustra', vers: '2.3.4', cksum: checksum, yanked: false });
    const report = await auditRegistry({
      root: rootFixture(),
      candidate: { sha: 'a'.repeat(40), dirty: false },
      fetchImpl: fixtures({
        npm: response(404, ''),
        index: response(200, index),
        archive: response(200, archive),
      }),
    });
    assert.equal(report.crates[0].source.relation, relation);
    assert.equal(report.crates[0].source.dirty, dirty);
  }
});

test('treats omitted Cargo VCS dirty metadata as clean while preserving explicit dirty state', async () => {
  const revision = 'a'.repeat(40);
  const archive = gzipSync(
    Buffer.concat([
      tarEntry(
        'rustra-2.3.4/.cargo_vcs_info.json',
        JSON.stringify({ git: { sha1: revision }, path_in_vcs: '' }),
      ),
      Buffer.alloc(1024),
    ]),
  );
  const checksum = createHash('sha256').update(archive).digest('hex');
  const index = JSON.stringify({ name: 'rustra', vers: '2.3.4', cksum: checksum, yanked: false });
  const report = await auditRegistry({
    root: rootFixture(),
    candidate: { sha: revision, dirty: false },
    fetchImpl: fixtures({
      npm: response(404, ''),
      index: response(200, index),
      archive: response(200, archive),
    }),
  });
  assert.deepEqual(report.crates[0].source, { revision, relation: 'exact', dirty: false });
});

test('validates sparse index entries and exposes a yanked exact version separately from latest', async () => {
  const archive = crateArchive('rustra', '2.3.4', 'a'.repeat(40));
  const checksum = createHash('sha256').update(archive).digest('hex');
  const yanked = [
    JSON.stringify({ name: 'rustra', vers: '2.3.4', cksum: checksum, yanked: true }),
    JSON.stringify({ name: 'rustra', vers: '2.4.0', cksum: 'f'.repeat(64), yanked: false }),
  ].join('\n');
  const report = await auditRegistry({
    root: rootFixture(),
    candidate: { sha: 'a'.repeat(40), dirty: false },
    fetchImpl: fixtures({
      npm: response(404, ''),
      index: response(200, yanked),
      archive: response(200, archive),
    }),
  });
  assert.equal(report.crates[0].exactYanked, true);
  assert.equal(report.crates[0].latestVersion, '2.4.0');
  assert.match(renderRegistryMarkdown(report), /Yanked/);

  const malformed = await auditRegistry({
    root: rootFixture(),
    candidate: { sha: 'a'.repeat(40), dirty: false },
    fetchImpl: fixtures({
      npm: response(404, ''),
      index: response(200, JSON.stringify({ name: 'other', vers: '2.3.4', cksum: 'bad' })),
    }),
  });
  assert.equal(malformed.crates[0].publication, 'query-error');
  assert.equal(malformed.errors[0].kind, 'registry');
});

test('rejects prefix-only and otherwise invalid sparse semver values', async () => {
  for (const vers of ['2.4.0garbage', '01.2.3', '1.2.3-01', '1.2']) {
    const malformed = await auditRegistry({
      root: rootFixture(),
      candidate: { sha: 'a'.repeat(40), dirty: false },
      fetchImpl: fixtures({
        npm: response(404, ''),
        index: response(
          200,
          JSON.stringify({ name: 'rustra', vers, cksum: 'a'.repeat(64), yanked: false }),
        ),
      }),
    });
    assert.equal(malformed.crates[0].publication, 'query-error');
    assert.equal(malformed.errors[0].kind, 'registry');
  }
});

test('accepts digit-leading alphanumeric prereleases and applies SemVer ASCII and numeric ordering', async () => {
  const revision = 'a'.repeat(40);
  const archive = crateArchive('rustra', '2.3.4', revision);
  const checksum = createHash('sha256').update(archive).digest('hex');
  const versions = [
    ['2.3.4', checksum],
    ['2.4.0-0alpha', '1'.repeat(64)],
    ['2.4.0-123abc', '2'.repeat(64)],
    ['2.4.0-B', '3'.repeat(64)],
    ['2.4.0-a', '4'.repeat(64)],
    ['2.4.0-9007199254740992', '5'.repeat(64)],
    ['2.4.0-9007199254740993', '6'.repeat(64)],
  ];
  const index = versions
    .map(([vers, cksum]) => JSON.stringify({ name: 'rustra', vers, cksum, yanked: false }))
    .join('\n');
  const report = await auditRegistry({
    root: rootFixture(),
    candidate: { sha: revision, dirty: false },
    fetchImpl: fixtures({
      npm: response(404, ''),
      index: response(200, index),
      archive: response(200, archive),
    }),
  });
  assert.equal(report.errors.length, 0);
  assert.equal(report.crates[0].latestVersion, '2.4.0-a');

  const numericIndex = [
    ['2.3.4', checksum],
    ['2.4.0-9007199254740993', '6'.repeat(64)],
    ['2.4.0-9007199254740992', '5'.repeat(64)],
  ]
    .map(([vers, cksum]) => JSON.stringify({ name: 'rustra', vers, cksum, yanked: false }))
    .join('\n');
  const numericReport = await auditRegistry({
    root: rootFixture(),
    candidate: { sha: revision, dirty: false },
    fetchImpl: fixtures({
      npm: response(404, ''),
      index: response(200, numericIndex),
      archive: response(200, archive),
    }),
  });
  assert.equal(numericReport.crates[0].latestVersion, '2.4.0-9007199254740993');
});

test('rejects truncated tar entries and a VCS file outside the exact archive root', async () => {
  for (const archive of [
    gzipSync(Buffer.concat([tarEntry('other/.cargo_vcs_info.json', '{}'), Buffer.alloc(1024)])),
    gzipSync(Buffer.from('truncated tar')),
  ]) {
    const checksum = createHash('sha256').update(archive).digest('hex');
    const index = JSON.stringify({ name: 'rustra', vers: '2.3.4', cksum: checksum, yanked: false });
    const report = await auditRegistry({
      root: rootFixture(),
      candidate: { sha: 'a'.repeat(40), dirty: false },
      fetchImpl: fixtures({
        npm: response(404, ''),
        index: response(200, index),
        archive: response(200, archive),
      }),
    });
    assert.equal(report.errors[0].kind, 'archive');
    assert.equal(report.crates[0].source.relation, 'unknown');
  }
});

test('bounds registry fetches with an abort timeout', async () => {
  const keepAlive = setTimeout(() => {}, 100);
  const fetchImpl = (_url, { signal } = {}) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  const report = await auditRegistry({
    root: rootFixture(),
    candidate: { sha: 'a'.repeat(40), dirty: false },
    fetchImpl,
    timeoutMs: 5,
  });
  clearTimeout(keepAlive);
  assert.equal(report.npm[0].publication, 'query-error');
  assert.equal(report.errors[0].kind, 'network');
});

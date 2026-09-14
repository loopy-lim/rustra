#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const NPM_REGISTRY = 'https://registry.npmjs.org';
const CRATES_INDEX = 'https://index.crates.io';
const CRATES_ARCHIVES = 'https://static.crates.io/crates';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function source(revision, candidateSha, dirty = null) {
  const normalized =
    typeof revision === 'string' && /^[0-9a-f]{40}$/i.test(revision)
      ? revision.toLowerCase()
      : null;
  return {
    revision: normalized,
    relation:
      normalized === null || dirty === true
        ? 'unknown'
        : normalized === candidateSha.toLowerCase()
          ? 'exact'
          : 'different',
    dirty,
  };
}

function auditError(kind, message) {
  const error = new Error(message);
  error.auditKind = kind;
  return error;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function candidateFromGit(root) {
  return {
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty:
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).length > 0,
  };
}

function npmManifests(root) {
  const packagesRoot = join(root, 'packages');
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesRoot, entry.name, 'package.json'))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .map((path) => ({ path, manifest: readJson(path) }))
    .filter(
      ({ manifest }) =>
        !manifest.private &&
        typeof manifest.name === 'string' &&
        typeof manifest.version === 'string',
    )
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

function cargoWorkspaceVersion(root) {
  const cargo = readFileSync(join(root, 'Cargo.toml'), 'utf8');
  const version = cargo.match(/^\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error('workspace.package.version not found');
  return version;
}

function crateManifests(root) {
  const cratesRoot = join(root, 'crates');
  const workspaceVersion = cargoWorkspaceVersion(root);
  return readdirSync(cratesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(cratesRoot, entry.name, 'Cargo.toml'))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .map((path) => {
      const text = readFileSync(path, 'utf8');
      const packageStart = text.search(/^\[package\]\s*$/m);
      const packageBodyStart = packageStart < 0 ? -1 : text.indexOf('\n', packageStart) + 1;
      const nextSectionOffset =
        packageBodyStart < 0 ? -1 : text.slice(packageBodyStart).search(/^\[/m);
      const packageBlock =
        packageBodyStart < 0
          ? ''
          : text.slice(
              packageBodyStart,
              nextSectionOffset < 0 ? undefined : packageBodyStart + nextSectionOffset,
            );
      return {
        path,
        name: packageBlock.match(/^name\s*=\s*"([^"]+)"/m)?.[1],
        version: packageBlock.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? workspaceVersion,
        publish: packageBlock.match(/^publish\s*=\s*false/m) ? false : true,
      };
    })
    .filter((manifest) => manifest.publish && manifest.name && manifest.version)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function sparsePath(name) {
  const value = name.toLowerCase();
  if (value.length === 1) return `1/${value}`;
  if (value.length === 2) return `2/${value}`;
  if (value.length === 3) return `3/${value[0]}/${value}`;
  return `${value.slice(0, 2)}/${value.slice(2, 4)}/${value}`;
}

function versionParts(version) {
  const numeric = '0|[1-9]\\d*';
  const identifier = `(?:${numeric}|(?=[0-9A-Za-z-]*[A-Za-z-])[0-9A-Za-z-]+)`;
  const match = new RegExp(
    `^(${numeric})\\.(${numeric})\\.(${numeric})(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  ).exec(version);
  return match ? [match[1], match[2], match[3], match[4]?.split('.') ?? null] : null;
}

function compareNumericStrings(left, right) {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return left.localeCompare(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = compareNumericStrings(a[index], b[index]);
    if (difference !== 0) return difference;
  }
  if (a[3] === null && b[3] === null) return 0;
  if (a[3] === null) return 1;
  if (b[3] === null) return -1;
  for (let index = 0; index < Math.max(a[3].length, b[3].length); index += 1) {
    if (a[3][index] === undefined) return -1;
    if (b[3][index] === undefined) return 1;
    if (a[3][index] === b[3][index]) continue;
    const aNumeric = /^\d+$/.test(a[3][index]);
    const bNumeric = /^\d+$/.test(b[3][index]);
    if (aNumeric && bNumeric) return compareNumericStrings(a[3][index], b[3][index]);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a[3][index] < b[3][index] ? -1 : 1;
  }
  return 0;
}

function tarFile(buffer, wantedPath) {
  let tar;
  try {
    tar = gunzipSync(buffer);
  } catch (error) {
    throw auditError('archive', `invalid gzip archive: ${errorText(error)}`);
  }
  if (tar.length < 1024 || tar.length % 512 !== 0) {
    throw auditError('archive', `invalid tar length ${tar.length}`);
  }
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const readString = (start, end) => header.subarray(start, end).toString().replace(/\0.*$/, '');
    const name = readString(0, 100);
    const prefix = readString(345, 500);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = readString(124, 136).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw auditError('archive', `invalid tar size for ${fullName}`);
    const size = Number.parseInt(sizeText, 8);
    const dataStart = offset + 512;
    const nextOffset = dataStart + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(size) || dataStart + size > tar.length || nextOffset > tar.length) {
      throw auditError('archive', `truncated tar entry ${fullName}`);
    }
    if (fullName === wantedPath) return tar.subarray(dataStart, dataStart + size);
    offset = nextOffset;
  }
  throw auditError('archive', `missing ${wantedPath}`);
}

function recordError(report, ecosystem, name, kind, message) {
  report.errors.push({ ecosystem, name, kind, message });
}

function fetchOptions(timeoutMs, options = {}) {
  return { ...options, signal: AbortSignal.timeout(timeoutMs) };
}

function validateNpmMetadata(metadata, name) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw auditError('registry', `invalid npm metadata for ${name}`);
  }
  if (
    !metadata.versions ||
    typeof metadata.versions !== 'object' ||
    Array.isArray(metadata.versions)
  ) {
    throw auditError('registry', `invalid npm versions for ${name}`);
  }
  if (
    !metadata['dist-tags'] ||
    typeof metadata['dist-tags'] !== 'object' ||
    typeof metadata['dist-tags'].latest !== 'string' ||
    !versionParts(metadata['dist-tags'].latest)
  ) {
    throw auditError('registry', `invalid npm dist-tags for ${name}`);
  }
}

function validNpmDist(dist) {
  if (!dist || typeof dist !== 'object' || Array.isArray(dist)) return false;
  let tarball;
  try {
    tarball = new URL(dist.tarball);
  } catch {
    return false;
  }
  if (tarball.protocol !== 'https:') return false;
  const validShasum = typeof dist.shasum === 'string' && /^[0-9a-f]{40}$/i.test(dist.shasum);
  const validIntegrity =
    typeof dist.integrity === 'string' &&
    /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(dist.integrity);
  return validShasum || validIntegrity;
}

async function auditNpm(manifest, report, fetchImpl, timeoutMs) {
  const { name, version } = manifest;
  const registryUrl = `${NPM_REGISTRY}/${encodeURIComponent(name)}`;
  const base = {
    name,
    workspaceVersion: version,
    exactVersion: null,
    latestVersion: null,
    publication: 'unpublished',
    source: source(null, report.candidate.sha),
    registryUrl,
    dist: null,
    error: null,
  };
  try {
    const response = await fetchImpl(
      registryUrl,
      fetchOptions(timeoutMs, { headers: { accept: 'application/json' } }),
    );
    if (response.status === 404) return base;
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
    const metadata = await response.json();
    validateNpmMetadata(metadata, name);
    const hasExact = Object.prototype.hasOwnProperty.call(metadata.versions, version);
    const exact = metadata.versions[version];
    base.latestVersion = metadata['dist-tags']?.latest ?? null;
    if (!hasExact) return base;
    if (
      !exact ||
      typeof exact !== 'object' ||
      Array.isArray(exact) ||
      exact.name !== name ||
      exact.version !== version ||
      !validNpmDist(exact.dist)
    ) {
      throw auditError('registry', `invalid npm exact metadata for ${name}@${version}`);
    }
    base.exactVersion = exact.version ?? version;
    base.publication = 'published';
    base.source = source(exact.gitHead, report.candidate.sha);
    base.dist = exact.dist ?? null;
    return base;
  } catch (error) {
    base.publication = 'query-error';
    base.error = errorText(error);
    recordError(
      report,
      'npm',
      name,
      error.auditKind ?? (/HTTP/.test(base.error) ? 'registry' : 'network'),
      base.error,
    );
    return base;
  }
}

function validateSparseEntry(entry, name) {
  if (
    !entry ||
    entry.name !== name ||
    typeof entry.vers !== 'string' ||
    !versionParts(entry.vers) ||
    typeof entry.cksum !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(entry.cksum) ||
    typeof entry.yanked !== 'boolean'
  ) {
    throw auditError('registry', `invalid sparse index entry for ${name}`);
  }
}

async function auditCrate(manifest, report, fetchImpl, timeoutMs) {
  const { name, version } = manifest;
  const registryUrl = `${CRATES_INDEX}/${sparsePath(name)}`;
  const base = {
    name,
    workspaceVersion: version,
    exactVersion: null,
    exactYanked: null,
    latestVersion: null,
    publication: 'unpublished',
    source: source(null, report.candidate.sha),
    registryUrl,
    archiveUrl: null,
    checksum: null,
    error: null,
  };
  try {
    const indexResponse = await fetchImpl(registryUrl, fetchOptions(timeoutMs));
    if (indexResponse.status === 404) return base;
    if (!indexResponse.ok)
      throw new Error(`crates sparse index returned HTTP ${indexResponse.status}`);
    const entries = (await indexResponse.text())
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (entries.length === 0) throw auditError('registry', `empty sparse index for ${name}`);
    for (const entry of entries) validateSparseEntry(entry, name);
    const available = entries.filter((entry) => !entry.yanked);
    base.latestVersion =
      available
        .map((entry) => entry.vers)
        .sort(compareVersions)
        .at(-1) ?? null;
    const exact = entries.find((entry) => entry.vers === version);
    if (!exact) return base;
    base.exactVersion = version;
    base.exactYanked = exact.yanked;
    base.publication = 'published';
    base.archiveUrl = `${CRATES_ARCHIVES}/${name}/${name}-${version}.crate`;
    const archiveResponse = await fetchImpl(base.archiveUrl, fetchOptions(timeoutMs));
    if (!archiveResponse.ok)
      throw new Error(`crate archive returned HTTP ${archiveResponse.status}`);
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    const actual = createHash('sha256').update(archive).digest('hex');
    const verified = actual === exact.cksum;
    base.checksum = { expected: exact.cksum, actual, verified };
    if (!verified) {
      const message = `checksum mismatch: expected ${exact.cksum}, received ${actual}`;
      base.error = message;
      recordError(report, 'crates', name, 'checksum', message);
      return base;
    }
    const vcsFile = tarFile(archive, `${name}-${version}/.cargo_vcs_info.json`);
    let vcs;
    try {
      vcs = JSON.parse(vcsFile.toString('utf8'));
    } catch (error) {
      throw auditError('archive', `invalid .cargo_vcs_info.json: ${errorText(error)}`);
    }
    if (!vcs.git || (vcs.git.dirty !== undefined && typeof vcs.git.dirty !== 'boolean')) {
      throw auditError('archive', 'invalid .cargo_vcs_info.json git metadata');
    }
    base.source = source(vcs.git.sha1, report.candidate.sha, vcs.git.dirty === true);
    return base;
  } catch (error) {
    base.publication = base.exactVersion ? 'published' : 'query-error';
    base.error = errorText(error);
    const kind =
      error.auditKind ??
      (/HTTP|JSON|Unexpected|invalid/i.test(base.error) ? 'registry' : 'network');
    recordError(report, 'crates', name, kind, base.error);
    return base;
  }
}

function artifactRecord(root, artifactPath) {
  const path = resolve(root, artifactPath);
  const bytes = readFileSync(path);
  return {
    path: relative(root, path) || basename(path),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function auditRegistry({
  root = process.cwd(),
  fetchImpl = fetch,
  artifactPaths = [],
  candidate,
  timeoutMs = 15_000,
} = {}) {
  const report = {
    schemaVersion: 1,
    fetchedAt: new Date().toISOString(),
    candidate: candidate ?? candidateFromGit(root),
    npm: [],
    crates: [],
    artifacts: [],
    errors: [],
  };
  for (const { manifest } of npmManifests(root))
    report.npm.push(await auditNpm(manifest, report, fetchImpl, timeoutMs));
  for (const manifest of crateManifests(root))
    report.crates.push(await auditCrate(manifest, report, fetchImpl, timeoutMs));
  for (const artifactPath of artifactPaths) {
    try {
      report.artifacts.push(artifactRecord(root, artifactPath));
    } catch (error) {
      recordError(report, 'local', String(artifactPath), 'artifact', errorText(error));
    }
  }
  return report;
}

function cell(value) {
  return value === null || value === undefined || value === ''
    ? '—'
    : String(value).replaceAll('|', '\\|');
}

export function renderRegistryMarkdown(report) {
  const lines = [
    '# Release registry audit',
    '',
    `- Fetched at: \`${report.fetchedAt}\``,
    `- Candidate: \`${report.candidate.sha}\` (${report.candidate.dirty ? 'dirty' : 'clean'})`,
    '',
    'A mixed version matrix and a registry source older than the candidate are valid audit results. Only query, archive, checksum, or local artifact failures make the audit operationally unsuccessful.',
    '',
    '## npm packages',
    '',
    '| Package | Workspace | Exact | Latest | Publication | Registry source | Relation | Dist tarball |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.npm.map(
      (entry) =>
        `| ${cell(entry.name)} | ${cell(entry.workspaceVersion)} | ${cell(entry.exactVersion)} | ${cell(entry.latestVersion)} | ${cell(entry.publication)} | ${cell(entry.source.revision)} | ${cell(entry.source.relation)} | ${cell(entry.dist?.tarball)} |`,
    ),
    '',
    '## crates.io crates',
    '',
    '| Crate | Workspace | Exact | Yanked | Latest | Publication | Archive SHA-256 | Verified | VCS source | Dirty | Relation |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.crates.map(
      (entry) =>
        `| ${cell(entry.name)} | ${cell(entry.workspaceVersion)} | ${cell(entry.exactVersion)} | ${cell(entry.exactYanked)} | ${cell(entry.latestVersion)} | ${cell(entry.publication)} | ${cell(entry.checksum?.actual)} | ${cell(entry.checksum?.verified)} | ${cell(entry.source.revision)} | ${cell(entry.source.dirty)} | ${cell(entry.source.relation)} |`,
    ),
    '',
    '## Local artifact evidence',
    '',
    'These hashes identify local generated/native files only. They do not prove registry publication or physical-device runtime.',
    '',
    '| Path | Bytes | SHA-256 |',
    '| --- | ---: | --- |',
    ...(report.artifacts.length
      ? report.artifacts.map(
          (entry) => `| ${cell(entry.path)} | ${entry.bytes} | ${entry.sha256} |`,
        )
      : ['| — | — | — |']),
    '',
    '## Operational errors',
    '',
    ...(report.errors.length
      ? report.errors.map(
          (entry) => `- ${entry.ecosystem}/${entry.name} (${entry.kind}): ${entry.message}`,
        )
      : ['None.']),
    '',
  ];
  return lines.join('\n');
}

function parseArgs(argv) {
  const result = { artifactPaths: [], output: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--artifact') result.artifactPaths.push(argv[++index]);
    else if (argv[index] === '--output') result.output = argv[++index];
    else if (argv[index] === '--help') result.help = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (result.artifactPaths.some((path) => !path)) throw new Error('--artifact requires a path');
  if (argv.includes('--output') && !result.output) throw new Error('--output requires a path');
  return result;
}

async function run() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(errorText(error));
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(
      'Usage: node scripts/audit-release-registry.mjs [--output receipt.json] [--artifact PATH ...]',
    );
    return;
  }
  const report = await auditRegistry({ root: process.cwd(), artifactPaths: options.artifactPaths });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const output = resolve(options.output);
    writeFileSync(output, json);
    const markdown = extname(output) === '.json' ? output.slice(0, -5) + '.md' : `${output}.md`;
    writeFileSync(markdown, renderRegistryMarkdown(report));
    console.log(`registry audit receipts: ${output}, ${markdown}`);
  } else console.log(json.trimEnd());
  if (report.errors.length > 0) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await run();

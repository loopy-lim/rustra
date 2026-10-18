import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * 영수증 출력 경로 해상 — 요청이 없으면 target/onboarding-receipts 의 기본 이름.
 * Receipts are evidence; an accidental rerun must not replace an earlier result.
 */
export function openReceiptTarget({ requested, defaultName, repo, label = 'receipt' }) {
  const output = resolve(requested ?? join(repo, 'target/onboarding-receipts', defaultName));
  if (existsSync(output)) throw new Error(`${label} receipt already exists: ${output}`);
  return output;
}

/** raw 로그 디렉터리 규약 — 영수증 경로에 .logs 를 붙인 형제 디렉터리. */
export function openRawLogDirectory(output) {
  const rawLogDirectory = `${output}.logs`;
  mkdirSync(rawLogDirectory, { recursive: true });
  return rawLogDirectory;
}

/**
 * 스캐폴드 프로젝트의 네이티브 산출물 상대경로 — `cargo build` 가
 * cargoTargetDir/debug 아래에 두는 규약(bin(node): 확장자 없음, win에서만 .exe /
 * cdylib(bun): 플랫폼 접두사·확장자).
 */
export function scaffoldNativeArtifactPath(host) {
  const fileName =
    host === 'bun'
      ? process.platform === 'win32'
        ? 'rustra_app.dll'
        : process.platform === 'darwin'
          ? 'librustra_app.dylib'
          : 'librustra_app.so'
      : `rustra-app${process.platform === 'win32' ? '.exe' : ''}`;
  return `debug/${fileName}`;
}

/**
 * 생산자(packages/cli 빌드물) 지문 — 여정 전에 capture 로 잡아두고, 여정 뒤
 * stampProducerStability 가 같은 빌드물 위의 여정인지(producerStable)를 채운다.
 */
export function captureProducerArtifact(repo) {
  return onboardingPackageArtifact(join(repo, 'packages/cli'));
}

export function stampProducerStability(repo, receipt) {
  if (!receipt.producerBefore) throw new Error('capture the producer artifact before the journey');
  receipt.producerAfter = captureProducerArtifact(repo);
  receipt.producerStable = receipt.producerBefore.sha256 === receipt.producerAfter.sha256;
}

/** Hash the built JavaScript that actually executes, separately from the source checkout. */
export function onboardingPackageArtifact(directory) {
  if (!existsSync(join(directory, 'package.json'))) return null;
  const resolvedDirectory = realpathSync(directory);
  const manifest = JSON.parse(readFileSync(join(resolvedDirectory, 'package.json'), 'utf8'));
  const digest = createHash('sha256');
  const files = ['package.json'];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (
        /\.(js|mjs|cjs|json)$/.test(entry.name) &&
        (entry.isFile() || (entry.isSymbolicLink() && statSync(absolute).isFile()))
      )
        files.push(relative(resolvedDirectory, absolute));
    }
  };
  if (existsSync(join(resolvedDirectory, 'dist'))) walk(join(resolvedDirectory, 'dist'));
  if (files.length === 1) throw new Error(`built JavaScript is missing in ${directory}`);
  for (const file of files)
    digest.update(`${file}\0`).update(readFileSync(join(resolvedDirectory, file)));
  return {
    name: manifest.name,
    version: manifest.version,
    resolvedDirectory,
    files: files.length,
    sha256: digest.digest('hex'),
  };
}

/** Evidence classes are explicit: locally patched journeys cannot certify published packages. */
export function onboardingReceipt({
  report,
  sourceBefore,
  sourceAfter,
  environment,
  consumption,
  rawLogDirectory,
}) {
  if (
    ![
      'source-injected',
      'source-cli-registry-dependencies',
      'packed-local',
      'registry-only',
    ].includes(consumption)
  ) {
    throw new Error(`unknown onboarding consumption mode: ${consumption}`);
  }
  const through = (name) => {
    const step = report.steps.find((entry) => entry.name === name);
    return step?.ok === false || !step ? null : step.completedAfterMs;
  };
  const interval = (first, last) => {
    const start = report.steps.find((entry) => entry.name === first);
    const end = report.steps.find((entry) => entry.name === last);
    if (!start || !end || end.ok === false) return null;
    return end.completedAfterMs - start.startedAfterMs;
  };
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    ok: report.ok,
    consumption,
    sourceBefore,
    sourceAfter,
    sourceStable: sourceBefore.sourceTreeHash === sourceAfter.sourceTreeHash,
    environment,
    cache: report.cache,
    measurements: {
      firstRustCallMs: through(
        report.steps.some((step) => step.name === 'first-call') ? 'first-call' : 'demo',
      ),
      warmStartMs: interval('warm-start', 'warm-start'),
      contractChangeToCallMs: interval('mutate', 'verify'),
      javascriptChangeToCallMs: interval('javascript-change', 'javascript-verify'),
      rustImplementationChangeToCallMs: interval('implementation-change', 'implementation-verify'),
    },
    iterationMethod: 'explicit-command',
    rawLogDirectory,
    steps: report.steps,
    ...(report.error ? { error: report.error } : {}),
  };
}

export function writeOnboardingReceipt(path, receipt) {
  mkdirSync(dirname(path), { recursive: true });
  // Receipts are evidence; an accidental rerun must not replace an earlier result.
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
}

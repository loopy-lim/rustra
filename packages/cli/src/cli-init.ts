import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { renderInitProjectFiles, templateVersions, type InitHosts } from './init-template.js';
import { cliManifest, cliVersion } from './cli-runtime.js';
import { parseCliArgs } from './cli-arg-parser.js';
import { UsageError } from './cli-usage-error.js';
import { closestMatch } from './cli-suggest.js';

/** --host 허용값 — 검증·did-you-mean·도움말이 함께 읽는 단일 출처. */
export const INIT_HOSTS = ['node', 'react-native'] as const;
type InitHost = (typeof INIT_HOSTS)[number];

/**
 * init 대상 디렉터리의 package.json 의존성에서 RN 호스트를 감지한다.
 * 관례는 최소 유지 — react-native(-.*)? 이름만 스캔하고(@react-native/* 스코프 제외),
 * package.json 이 없거나 읽을 수 없으면 node-only 를 기본으로 삼는다. doctor 재실행이 아니다.
 */
export function detectInitHosts(root: string): InitHosts {
  const RN_PACKAGE = /^react-native(?:-.*)?$/;
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    return { reactNative: names.some((name) => RN_PACKAGE.test(name)) };
  } catch {
    return { reactNative: false };
  }
}

export async function runInit(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, {
    command: 'init',
    valueFlags: ['host'],
    booleanFlags: ['force', 'help'],
    allowPositionals: true,
  });
  // help 관례 — 파서는 플래그만 채우고 출력은 cli-main 이 담당한다. 도메인
  // 검증(positional 수·host 값·덮어쓰기 확인)보다 help 가 우선한다.
  if (parsed.flags.has('help')) return;
  const force = parsed.flags.has('force');
  const hostValue = parsed.values.get('host');
  if (hostValue !== undefined && !INIT_HOSTS.includes(hostValue as InitHost)) {
    // arg-parser/unknownValueError 관례 — nearest 후보 did-you-mean + 허용값 전체 나열.
    const suggestion = closestMatch(hostValue, INIT_HOSTS);
    const hint = suggestion
      ? ` Did you mean "${suggestion}"?`
      : ` Supported hosts: ${INIT_HOSTS.join(', ')}.`;
    throw new Error(`Unknown init --host value "${hostValue}".${hint}`);
  }
  const directories = parsed.positionals;
  if (directories.length !== 1)
    throw new UsageError('Provide one project directory. Usage: rustra init my-project [--force]');
  const root = resolve(directories[0]!);
  // 감지는 파일을 쓰기 전에 — 기존 프로젝트 위로 init 하는 경우가 관찰 대상이다.
  const detected = detectInitHosts(root);
  const hosts: InitHosts = {
    reactNative: hostValue === 'react-native' || (hostValue === undefined && detected.reactNative),
  };
  const versions = templateVersions(
    cliVersion,
    cliManifest.dependencies['@rustra/types'],
    cliManifest.rustraTemplate.cargoRange,
  );
  const files = renderInitProjectFiles(versions, hosts);
  const contents: Record<string, string> = {
    'Cargo.toml': files.cargoToml,
    'src/lib.rs': files.libRs,
    'src/main.rs': files.mainRs,
    'src/bin/generate.rs': files.generateRs,
    'src/index.ts': files.appTs,
    'package.json': files.packageJson,
    'rustra.json': files.rustraJson,
    '.gitignore': files.gitignore,
    'tsconfig.json': files.tsconfig,
  };
  const existing = Object.keys(contents).filter((file) => existsSync(resolve(root, file)));
  if (existing.length > 0 && !force)
    throw new Error(
      `Refusing to overwrite existing files in ${root}: ${existing.join(', ')}. Re-run with --force to replace them.`,
    );
  for (const [file, content] of Object.entries(contents)) {
    const path = resolve(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  console.log(`Created rustra project in ${root}:`);
  console.log(`  ${Object.keys(contents).join(', ')}`);
  const hostSummary = hosts.reactNative ? 'node, react-native' : 'node';
  // 선택 이유 표시 — --host 로 감지를 바꿨다면 그 사실을 안내해 "왜 RN이 빠졌는지"를 남긴다.
  const hostNote =
    hostValue !== undefined
      ? ' (--host)'
      : hosts.reactNative
        ? ' (package.json)'
        : detected.reactNative
          ? ' (--host override)'
          : '';
  console.log(`  Config host sections: ${hostSummary}${hostNote}`);
  console.log('\nNext steps:');
  console.log(`  cd ${directories[0]}`);
  console.log('  bun install');
  console.log('  bun run codegen');
  console.log('  bun run demo');
  console.log('  cargo run');
}

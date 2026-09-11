// 코드젠 신선도 게이트 — examples/ 아래 rustra.json 을 가진 모든 예제의 committed
// generated/ 디렉터리가 실제 재생성 결과와 일치하는지 단언한다. 검사는 repo CLI
// `codegen --config rustra.json --check` 을 고정 호출한다 — 예제 package.json 의
// `codegen:check` 같은 diff 내 가변 스크립트는 신뢰 앵커가 못 된다(스크립트를
// exit 0 으로 바꾸면 게이트가 통과해버린다). `--check` 은 임시 디렉터리에
// 렌더링해 비교하므로 검사 자체는 기존 생성물을 더럽히지 않는다.
//
// 드리프트 해결 방법: 해당 예제 디렉터리에서 `bun run codegen` 을 실행해 committed
// 생성물을 갱신한 뒤 커밋한다. 생성물이 의도적 변경이 아니라면 판단 없이 갱신하지
// 않는다 — 먼저 드리프트 원인(schema/제너레이터 변경)을 확인한다.
//
// 사용법: `node scripts/check-codegen-fresh.mjs` (전수), `--example <name>` (단일,
// 반복 지정 가능 — 로컬 디버깅용).
//
// 감지 범위 / known blind spots:
// - rustra.json 이 없는 예제(calculator-napi, tauri-calculator 등)와 generated/ 만
//   커밋돼 있고 설정이 없는 예제(auth, crud)는 이 게이트 밖이다 — 설정이 생기면
//   자동으로 편입된다.
// - react-native-calculator 의 `codegen` 은 build:fingerprint 도 돌리지만 고정
//   `--check` 호출은 fingerprint 를 검사하지 않는다(check 모드의 원래 범위).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_FILE = '.rustra-generated.json';

/** examples/ 아래 rustra.json 을 가진 예제를 이름순으로 수집한다. */
export function discoverCodegenExamples(root) {
  const examplesDir = join(root, 'examples');
  if (!existsSync(examplesDir)) return [];
  const discovered = [];
  for (const name of readdirSync(examplesDir).sort()) {
    const dir = join(examplesDir, name);
    const configPath = join(dir, 'rustra.json');
    if (!existsSync(configPath)) continue;
    let config;
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new Error(`${configPath} 을(를) 파싱할 수 없다: ${error.message}`);
    }
    // CLI codegen --check 의 선행 조건(cli-codegen.ts)과 동일한 경로: committed
    // manifest 가 없으면 check 자체가 성립하지 않으므로 그대로 실패로 보고한다.
    const manifestPath = join(dir, config.output ?? 'generated', MANIFEST_FILE);
    discovered.push({ name, dir, configPath, config, manifestPath });
  }
  return discovered;
}

/**
 * 검사 커맨드 — 항상 repo CLI 를 직접 --check 로 호출한다. 예제 package.json 의
 * `codegen:check` 은 참조하지 않는다: 그 스크립트는 PR diff 에서 수정 가능하므로,
 * 게이트가 그것을 실행하면 스크립트를 `exit 0` 으로 바꾸는 것만으로 게이트가
 * 무력화된다. 신뢰 앵커는 게이트 밖(이 스크립트 + repo CLI)에 고정돼야 한다.
 */
export function resolveCheckCommand(example, root) {
  return {
    file: 'bun',
    args: [
      join(root, 'packages', 'cli', 'src', 'index.ts'),
      'codegen',
      '--config',
      'rustra.json',
      '--check',
    ],
    cwd: example.dir,
  };
}

const defaultExec = (command) =>
  spawnSync(command.file, command.args, {
    cwd: command.cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

/**
 * 예제들을 순서대로 검사한다. 첫 드리프트에서 중단하고 그 예제의 전체 출력을
 * diagnostics 로 남긴다(나머지 예제는 같은 원인일 가능성이 높다 — 첫 진단이
 * 판단의 근거가 된다). exec 은 테스트 주입용.
 */
export function runCodegenFreshChecks({ root, filter = null, exec = defaultExec } = {}) {
  const discovered = discoverCodegenExamples(root);
  const targets =
    filter && filter.size > 0
      ? discovered.filter((example) => filter.has(example.name))
      : discovered;
  if (targets.length === 0) {
    return {
      ok: false,
      failures: [
        {
          name: filter ? [...filter].join(', ') : '(none)',
          reason:
            '게이트 대상 예제가 0개다 — examples/*/rustra.json 이 존재하는지 확인한다' +
            (filter ? ' (--example 필터 오타 가능)' : ''),
          output: '',
        },
      ],
      ran: 0,
    };
  }
  const failures = [];
  let ran = 0;
  for (const example of targets) {
    ran++;
    if (!existsSync(example.manifestPath)) {
      failures.push({
        name: example.name,
        reason: `committed manifest 가 없다: ${example.manifestPath} — 예제 디렉터리에서 bun run codegen 을 실행해 생성물을 커밋한다`,
        output: '',
      });
      break;
    }
    const command = resolveCheckCommand(example, root);
    const result = exec(command);
    if (result.status !== 0) {
      failures.push({
        name: example.name,
        reason:
          `codegen check 실패 (exit ${result.status ?? 'signal'}) — ` +
          `예제 디렉터리에서 bun run codegen 실행 후 생성물을 커밋하거나, ` +
          `의도하지 않은 드리프트면 원인(schema/제너레이터 변경)을 먼저 확인한다`,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
      });
      break;
    }
  }
  return { ok: failures.length === 0, failures, ran };
}

function run() {
  const root = process.cwd();
  const filter = new Set();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--example') {
      const value = argv[i + 1];
      if (!value) throw new Error('--example 에는 예제 이름이 필요하다');
      filter.add(value);
      i++;
      continue;
    }
    throw new Error(`알 수 없는 인자: ${argv[i]} (--example <name> 만 지원한다)`);
  }
  const { ok, failures, ran } = runCodegenFreshChecks({ root, filter });
  if (!ok) {
    for (const failure of failures) {
      console.error(`FAIL ${failure.name}: ${failure.reason}`);
      if (failure.output) {
        console.error(`--- ${failure.name} 출력 ---`);
        console.error(failure.output);
      }
    }
    process.exitCode = 1;
    return;
  }
  console.log(`OK: ${ran}개 예제 codegen check 통과 (committed 생성물이 재현 결과와 일치)`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) run();

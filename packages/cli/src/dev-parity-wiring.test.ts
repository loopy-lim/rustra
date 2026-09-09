import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDev } from './dev.js';
import { cliManifest } from './cli-runtime.js';

// ── runConfigDev × parity gate 배선 계약 (Task A2) ──────────────────────────
//
// 실제 배선(runConfigDev → runCodegen → fake cargo → 게이트 검증)을 대상으로
// 세 가지를 증명한다:
//   (i)  계약 불일치 시 reload 신호가 호스트에게 방출되지 않는다(기존 엔진 유지)
//   (ii) 거부는 loud 하다 — "[dev] reload rejected — …"
//   (iii) 거부가 루프를 죽이지 않는다(다음 변경에 다시 판정)
//
// cargo 는 PATH 앞단의 fake 스크립트로 대체한다:
//   - `cargo metadata` → 단일 패키지 + `generate` bin + `rustra_bridge` staticlib
//     (resolveCodegenTarget / selectReactNativeCargoTarget 계약)
//   - `cargo run` → $FAKE_SCHEMA_FILE 을 generated/schema.json 으로 복사
//     ("Rust schema generation" 단계의 역할)
//   - `cargo build` → wasm32 엔진 빌드 대역(Task A3): $FAKE_WASM_LOG 에 인수를
//     기록하고 target/wasm32-unknown-unknown/release/<lib 이름>.wasm 을 만든다.
//     $FAKE_WASM_FAIL 이 설정되면 실패하고(reload 억제 계약 검증용),
//     $FAKE_WASM_NO_ARTIFACT 가 설정되면 성공하지만 산출물을 만들지 않는다.
// wasm dev-target은 reactNative 섹션을 요구하므로 RN 스캐폴드/의존성 경로도
// 실제로 돈다 — moduleDir 을 프로젝트 src 밖으로 분리해 감시 루프가 생성물을
// 소스 변경으로 오판하지 않게 한다.

const FAKE_BIN = 'fake-cargo-bin';
const SCHEMA_V1 = {
  packageId: 'app.demo',
  commands: [
    {
      name: 'echo',
      inputType: 'EchoInput',
      outputType: 'EchoOutput',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
      outputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
  ],
};

function writeSchema(path: string, messageType: string): void {
  const schema = structuredClone(SCHEMA_V1);
  (schema.commands[0]!.inputSchema.properties!.message as { type: string }).type = messageType;
  writeFileSync(path, JSON.stringify(schema));
}

/**
 * fake cargo 의 메타데이터 대역 변형 — 엔진 crate(`x`)의 lib 타깃 이름·크레이트 타입.
 *  - 기본 (`rustra_bridge`, staticlib+cdylib): codegen 의 RN staticlib 선택과 wasm
 *    cdylib 선택이 모두 성공하는 정상형.
 *  - `"staticlib"` 만: codegen 은 통과하지만 wasm 빌드가 cdylib 부재로 실패해야
 *    하는 음성형 — exactly-one-cdylib 강제 계약 검증용.
 *  - `"my_bridge"` + staticlib+cdylib: 커스텀 lib 이름형 — 산출물 이름이 패키지
 *    이름(`x.wasm`)이 아니라 lib 타깃 이름(`my_bridge.wasm`)에서 와야 한다는
 *    cargo 규약의 핀. 실제 cargo 는 `[lib] name` 으로 산출물 이름을 바꾼다.
 */
type EngineLibVariant = 'cdylib' | 'staticlib-only' | 'custom-name';

function seedProject(root: string, engineLib: EngineLibVariant = 'cdylib'): string {
  const project = join(root, 'proj');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'generated'), { recursive: true });
  mkdirSync(join(project, 'modules'), { recursive: true });
  mkdirSync(join(root, FAKE_BIN), { recursive: true });
  writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
  writeFileSync(join(project, 'src', 'lib.rs'), 'fn main() {}\n');
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 'proj', workspaces: [], dependencies: {} }),
  );
  // RN 스캐폴드 경로가 실제로 돈다 — 어댑터도 설치돼 있어야 한다(감사 A11: RN
  // 코드젠은 bun install 선행이 계약). cliManifest range 를 만족하는 버전으로 심는다.
  const adapterVersion = cliManifest.rustraTemplate.reactNativeRange.replace(/^[~^=]/, '');
  const adapterNative = join(project, 'node_modules', '@rustra', 'react-native', 'native');
  for (const file of [
    'android/rustra-jsi-jni.cpp',
    'cpp/RustraJSIBridge.cpp',
    'cpp/RustraJSIBridge.hpp',
    'cpp/rustra-codec.hpp',
    'ios/RustraJSIModule.mm',
  ]) {
    mkdirSync(join(adapterNative, ...file.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(adapterNative, ...file.split('/')), 'adapter fixture');
  }
  writeFileSync(
    join(project, 'node_modules', '@rustra', 'react-native', 'package.json'),
    JSON.stringify({ name: '@rustra/react-native', version: adapterVersion }),
  );
  writeFileSync(
    join(project, 'rustra.json'),
    JSON.stringify({
      schema: './generated/schema.json',
      output: './generated',
      reactNative: { moduleDir: './modules' },
      dev: { target: 'wasm', wasm: { engine: 'wasm3' } },
    }),
  );
  const libName = engineLib === 'custom-name' ? 'my_bridge' : 'rustra_bridge';
  const crateTypes = engineLib === 'staticlib-only' ? '["staticlib"]' : '["staticlib","cdylib"]';
  const fakeCargo = [
    '#!/bin/bash',
    'if [ "$1" = "metadata" ]; then',
    '  manifest=""; prev=""',
    '  for a in "$@"; do [ "$prev" = "--manifest-path" ] && manifest="$a"; prev="$a"; done',
    '  dir=$(dirname "$manifest")',
    '  printf \'{"target_directory":"%s/target","packages":[{"name":"x","manifest_path":"%s",',
    '"targets":[{"name":"generate","crate_types":["bin"],"kind":["bin"]},',
    `{"name":"${libName}","crate_types":${crateTypes},"kind":["lib"]}]}]}\\n' "$dir" "$manifest"`,
    '  exit 0',
    'fi',
    'if [ "$1" = "run" ]; then',
    '  manifest=""; prev=""',
    '  for a in "$@"; do [ "$prev" = "--manifest-path" ] && manifest="$a"; prev="$a"; done',
    '  dir=$(dirname "$manifest")',
    '  mkdir -p "$dir/generated"',
    '  cp "$FAKE_SCHEMA_FILE" "$dir/generated/schema.json"',
    '  exit 0',
    'fi',
    'if [ "$1" = "build" ]; then',
    '  [ -n "$FAKE_WASM_LOG" ] && printf \'%s\\n\' "$*" >> "$FAKE_WASM_LOG"',
    '  if [ -n "$FAKE_WASM_FAIL" ]; then echo "fake wasm build failure" >&2; exit 3; fi',
    '  manifest=""; prev=""; target=""',
    '  for a in "$@"; do',
    '    [ "$prev" = "--manifest-path" ] && manifest="$a"',
    '    [ "$prev" = "--target" ] && target="$a"',
    '    prev="$a"',
    '  done',
    '  dir=$(dirname "$manifest")',
    '  mkdir -p "$dir/target/$target/release"',
    '  if [ -n "$FAKE_WASM_NO_ARTIFACT" ]; then exit 0; fi',
    // cargo 규약: cdylib 산출물 이름은 lib 타깃 이름에서 온다([lib] name 반영).
    `  printf 'fake wasm engine' > "$dir/target/$target/release/${libName}.wasm"`,
    '  exit 0',
    'fi',
    'echo "unexpected cargo invocation: $*" >&2',
    'exit 1',
  ].join('\n');
  const fakePath = join(root, FAKE_BIN, 'cargo');
  writeFileSync(fakePath, fakeCargo);
  chmodSync(fakePath, 0o755);
  return project;
}

// watch → debounce → codegen → verify 왕복은 풀스위트 부하 하에서 들쭉날쭉하다 —
// 고정 sleep 대신 관찰 조건을 폴링한다(디바운스 상수와 무관하게 안정적). 타임아웃은
// 실패 시점까지 캡처한 로그를 그대로 보여준다.
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// 트리거는 "한 번 쓰고 기다림"이 아니라 "루프가 반응할 때까지 재터치"다. fs.watch 는
// 관찰 등록 직후의 첫 이벤트를 플랫폼 수준에서 잃을 수 있다(macOS 감시 스트림 arming
// 윈도우 — 8중 동시 재현에서 첫 쓰기 24중 13 손실, Bun·Node 공통, 등록 후 25ms 유예로
// 0으로 수렴 확인). 같은 내용을 다시 써도 mtime 이 바뀌어 새 이벤트가 걸리고,
// 코드젠(fake cargo 복사)과 게이트 판정은 멱등하므로 재터치는 관찰 조건을 바꾸지 않는다.
function triggerUntil(
  captured: () => string[],
  write: () => void,
  observe: () => boolean,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  const poll = async (): Promise<void> => {
    let nextTouch = 0;
    while (!observe()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; captured:\n${captured().join('\n')}`);
      }
      if (Date.now() >= nextTouch) {
        write();
        nextTouch = Date.now() + 500;
      }
      await sleep(100);
    }
  };
  return poll();
}

function captureConsole(into: string[]): () => void {
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (line: unknown) => into.push(String(line));
  console.log = (line: unknown) => into.push(`LOG ${String(line)}`);
  return () => {
    console.error = originalError;
    console.log = originalLog;
  };
}

test(
  'runConfigDev parity wiring: drifted codegen is rejected loudly without emitting reload',
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'rustra-dev-parity-e2e-'));
    const originalPath = process.env.PATH;
    try {
      const project = seedProject(root);
      writeSchema(join(project, 'generated', 'schema.json'), 'string');
      // 첫 판정의 기준이 될 계약(string). 트리거 런은 fake cargo 가 integer 계약을
      // 쓰게 한다 — 실제 스키마 드리프트 시나리오.
      writeSchema(join(root, 'schema-string.json'), 'string');
      writeSchema(join(root, 'schema-integer.json'), 'integer');

      process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
      process.env.FAKE_SCHEMA_FILE = join(root, 'schema-string.json');

      const errors: string[] = [];
      const restore = captureConsole(errors);
      const rejectionCount = (): number =>
        errors.filter((line) => line.includes('[dev] reload rejected —')).length;
      try {
        const handle = await runDev(['--config', join(project, 'rustra.json')]);
        const reloads: string[] = [];
        handle.onReload((reason) => void reloads.push(reason));

        // 트리거 1 — fake cargo 가 integer 계약을 쓴다 → 게이트가 거부해야 한다.
        // 거부 로그 자체가 "판정이 돌았다"는 양(陽) 관찰이자 동기화점이다.
        process.env.FAKE_SCHEMA_FILE = join(root, 'schema-integer.json');
        await triggerUntil(
          () => errors,
          () => writeFileSync(join(project, 'src', 'lib.rs'), 'fn changed() {}\n'),
          () =>
            errors.some(
              (line) => line.includes('[dev] reload rejected —') && line.includes('drift'),
            ),
          'the loud drift rejection',
        );

        // 트리거 2 — 원래 계약으로 복귀. 첫 거부에서 기준이 드리프트 상태로
        // 재무장됐으므로 복귀 역시 "기준 대비 드리프트"로 판정된다 — 거부 2회.
        // 핵심은 (iii): 두 거부 모두 루프를 죽이지 않고 다음 변경이 다시
        // 판정됐다는 것. (같은 상태 유지 시의 통과는 rearm 단위 테스트가 담당.)
        process.env.FAKE_SCHEMA_FILE = join(root, 'schema-string.json');
        await triggerUntil(
          () => errors,
          () => writeFileSync(join(project, 'src', 'lib.rs'), 'fn changed2() {}\n'),
          () => rejectionCount() >= 2,
          'the second (restored-contract) rejection',
        );

        // 두 번째 판정이 관찰된 뒤 짧은 유예 — 이 안에 reload 가 방출되지
        // 않았음이 곧 부정(i) 검증이다(거부는 reload 를 방출하지 않는다).
        await sleep(300);
        handle.dispose();
        assert.ok(rejectionCount() >= 2, `rejection must be loud, got: ${errors.join('\n')}`);
        assert.deepEqual(
          reloads,
          [],
          'drifted reload must not be emitted; the restored contract is also re-verified ' +
            '(baseline re-armed to the drifted state), so both triggers are rejected',
        );
      } finally {
        restore();
        delete process.env.FAKE_SCHEMA_FILE;
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// ── wasm 타깃 빌드 오케스트레이션 (Task A3) ──────────────────────────────────

test(
  'runConfigDev wasm target builds the wasm32 engine artifact and still reloads',
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'rustra-dev-wasm-'));
    const originalPath = process.env.PATH;
    try {
      const project = seedProject(root);
      writeSchema(join(project, 'generated', 'schema.json'), 'string');
      writeSchema(join(root, 'schema-string.json'), 'string');
      const wasmLog = join(root, 'wasm-build.log');
      process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
      process.env.FAKE_SCHEMA_FILE = join(root, 'schema-string.json');
      process.env.FAKE_WASM_LOG = wasmLog;

      const errors: string[] = [];
      const restore = captureConsole(errors);
      try {
        const handle = await runDev(['--config', join(project, 'rustra.json')]);
        const reloads: string[] = [];
        handle.onReload((reason) => void reloads.push(reason));

        // initial 강제 런이 codegen(cargo run)에 이어 wasm32 엔진 빌드(cargo build)를
        // 오케스트레이션한다 — runDev 반환 시점에 이미 빌드 기록과 아티팩트 안내가
        // 있어야 한다(A0 스파이크의 실빌드 명령과 동일: --target wasm32-unknown-unknown
        // --release, 산출물은 <target>/wasm32-unknown-unknown/release/<name>.wasm).
        const builds = readFileSync(wasmLog, 'utf8');
        assert.ok(
          builds.split('\n').some((line) => line.includes('--target wasm32-unknown-unknown')),
          `cargo build must target wasm32-unknown-unknown, got:\n${builds}`,
        );
        assert.ok(
          builds.split('\n').some((line) => line.includes('--release')),
          'the dev wasm build follows the A0 release-profile artifact layout',
        );
        assert.ok(
          errors.some(
            (line) =>
              line.includes('[dev:wasm] engine artifact:') &&
              line.includes(
                join('target', 'wasm32-unknown-unknown', 'release', 'rustra_bridge.wasm'),
              ),
          ),
          `the artifact path must be announced for the host push step, got:\n${errors.join('\n')}`,
        );

        // 이어지는 변경도 codegen → wasm 빌드 → reload 순서로 계속 오케스트레이션된다
        // (parity 게이트가 같은 계약을 유지하므로 reload 는 통과한다).
        await triggerUntil(
          () => errors,
          () => writeFileSync(join(project, 'src', 'lib.rs'), 'fn changed() {}\n'),
          () => reloads.length >= 1,
          'a reload after the wasm build',
        );
        handle.dispose();
        assert.ok(
          reloads.length >= 1,
          `reload must still fire after a successful wasm build, captured:\n${errors.join('\n')}`,
        );
        const buildsAfter = readFileSync(wasmLog, 'utf8');
        assert.ok(
          buildsAfter.split('\n').filter((line) => line.includes('--target wasm32-unknown-unknown'))
            .length >= 2,
          'every dirty run rebuilds the wasm32 engine, not just the initial one',
        );
      } finally {
        restore();
        delete process.env.FAKE_SCHEMA_FILE;
        delete process.env.FAKE_WASM_LOG;
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'runConfigDev wasm target suppresses reload when the wasm32 build fails',
  { timeout: 30_000 },
  async () => {
    // wasm 빌드 실패 = 호스트가 받을 새 엔진이 없다 — codegen 이 성공해도 reload 는
    // 방출되지 않는다(게이트 검증 이전에 실패가 전파되어 catch 로 간다).
    const root = mkdtempSync(join(tmpdir(), 'rustra-dev-wasm-fail-'));
    const originalPath = process.env.PATH;
    try {
      const project = seedProject(root);
      writeSchema(join(project, 'generated', 'schema.json'), 'string');
      writeSchema(join(root, 'schema-string.json'), 'string');
      process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
      process.env.FAKE_SCHEMA_FILE = join(root, 'schema-string.json');
      process.env.FAKE_WASM_FAIL = '1';

      const errors: string[] = [];
      const restore = captureConsole(errors);
      try {
        const handle = await runDev(['--config', join(project, 'rustra.json')]);
        const reloads: string[] = [];
        handle.onReload((reason) => void reloads.push(reason));
        // 유예 — 그 사이 reload 가 방출되지 않음이 곧 부정 검증이다.
        await sleep(300);
        handle.dispose();
        assert.ok(
          errors.some((line) => line.includes('[dev] regeneration failed')),
          `the wasm build failure must be loud, got:\n${errors.join('\n')}`,
        );
        assert.ok(
          !errors.some((line) => line.includes('[dev:wasm] engine artifact:')),
          'no artifact announcement when the build failed',
        );
        assert.deepEqual(
          reloads,
          [],
          'a failed wasm build must not emit reload — the host has no new engine to load',
        );
      } finally {
        restore();
        delete process.env.FAKE_SCHEMA_FILE;
        delete process.env.FAKE_WASM_FAIL;
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'runConfigDev wasm target fails loudly when the engine crate has no cdylib target',
  { timeout: 30_000 },
  async () => {
    // exactly-one-cdylib 강제 계약 — 엔진 crate에 cdylib 가 없으면 wasm32 산출물은
    // 애초에 나오지 않는다. codegen(RN staticlib 선택)은 통과하는 상태에서 wasm
    // 빌드 단계만 실패해야 하고, 에러는 cdylib 원인과 수정 힌트를 함께 말해야 한다
    // (조용한 스킵/무음 재시도 없음). reload 는 물론 방출되지 않는다.
    const root = mkdtempSync(join(tmpdir(), 'rustra-dev-wasm-nocdylib-'));
    const originalPath = process.env.PATH;
    try {
      const project = seedProject(root, 'staticlib-only');
      writeSchema(join(project, 'generated', 'schema.json'), 'string');
      writeSchema(join(root, 'schema-string.json'), 'string');
      process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
      process.env.FAKE_SCHEMA_FILE = join(root, 'schema-string.json');

      const errors: string[] = [];
      const restore = captureConsole(errors);
      try {
        const handle = await runDev(['--config', join(project, 'rustra.json')]);
        const reloads: string[] = [];
        handle.onReload((reason) => void reloads.push(reason));
        await sleep(300);
        handle.dispose();
        const failure = errors.find((line) => line.includes('[dev] regeneration failed'));
        assert.ok(failure, `the missing-cdylib case must be loud, got:\n${errors.join('\n')}`);
        assert.match(failure, /cdylib/, 'the error must name cdylib as the cause');
        assert.match(
          failure,
          /crate-type/,
          'the error must include the fix hint (Add crate-type = ["rlib", "cdylib"])',
        );
        assert.ok(
          !errors.some((line) => line.includes('[dev:wasm] engine artifact:')),
          'no artifact announcement without a cdylib target',
        );
        assert.deepEqual(reloads, [], 'no reload when the engine cannot be built for wasm32');
      } finally {
        restore();
        delete process.env.FAKE_SCHEMA_FILE;
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'runConfigDev wasm target derives the artifact name from the lib target, not the package',
  { timeout: 30_000 },
  async () => {
    // cargo 규약 핀 — cdylib 산출물 이름은 **lib 타깃** 이름에서 온다: 패키지 x 의
    // [lib] name = "my_bridge" 는 my_bridge.wasm 을 만든다(x.wasm 이 아니다). 이
    // 저장소의 RN 관례(lib${rustLibrary}.a)와 같은 이름 근원이다. 패키지 이름으로
    // 계산하면 커스텀 lib 이름에서 경로가 어긋나 재빌드마다 오탈 실패한다.
    const root = mkdtempSync(join(tmpdir(), 'rustra-dev-wasm-custom-'));
    const originalPath = process.env.PATH;
    try {
      const project = seedProject(root, 'custom-name');
      writeSchema(join(project, 'generated', 'schema.json'), 'string');
      writeSchema(join(root, 'schema-string.json'), 'string');
      process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
      process.env.FAKE_SCHEMA_FILE = join(root, 'schema-string.json');

      const errors: string[] = [];
      const restore = captureConsole(errors);
      try {
        const handle = await runDev(['--config', join(project, 'rustra.json')]);
        const reloads: string[] = [];
        handle.onReload((reason) => void reloads.push(reason));
        await triggerUntil(
          () => errors,
          () => writeFileSync(join(project, 'src', 'lib.rs'), 'fn changed() {}\n'),
          () => reloads.length >= 1,
          'a reload with a custom-named cdylib',
        );
        handle.dispose();
        assert.ok(
          errors.some(
            (line) =>
              line.includes('[dev:wasm] engine artifact:') &&
              line.includes(join('target', 'wasm32-unknown-unknown', 'release', 'my_bridge.wasm')),
          ),
          `the artifact name must follow the lib target (my_bridge.wasm), got:\n${errors.join('\n')}`,
        );
        assert.ok(
          reloads.length >= 1,
          `a correct artifact path must not break the loop, captured:\n${errors.join('\n')}`,
        );
      } finally {
        restore();
        delete process.env.FAKE_SCHEMA_FILE;
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'runConfigDev wasm target fails closed when cargo succeeds but the artifact is missing',
  { timeout: 30_000 },
  async () => {
    // 산출물 부재 fail-closed — cargo 가 성공해도 산출물이 없으면(프로필 불일치,
    // 예상 밖 target 레이아웃 등) 조용히 통과하지 않는다. existsSync 재확인이 이
    // 불일치를 loud 하게 잡는다.
    const root = mkdtempSync(join(tmpdir(), 'rustra-dev-wasm-noart-'));
    const originalPath = process.env.PATH;
    try {
      const project = seedProject(root);
      writeSchema(join(project, 'generated', 'schema.json'), 'string');
      writeSchema(join(root, 'schema-string.json'), 'string');
      process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
      process.env.FAKE_SCHEMA_FILE = join(root, 'schema-string.json');
      process.env.FAKE_WASM_NO_ARTIFACT = '1';

      const errors: string[] = [];
      const restore = captureConsole(errors);
      try {
        const handle = await runDev(['--config', join(project, 'rustra.json')]);
        const reloads: string[] = [];
        handle.onReload((reason) => void reloads.push(reason));
        await sleep(300);
        handle.dispose();
        const failure = errors.find((line) => line.includes('[dev] regeneration failed'));
        assert.ok(failure, `a silent artifact mismatch must not pass, got:\n${errors.join('\n')}`);
        assert.match(failure, /did not produce/, 'the error must name the missing artifact path');
        assert.ok(
          !errors.some((line) => line.includes('[dev:wasm] engine artifact:')),
          'no artifact announcement when the artifact never appeared',
        );
        assert.deepEqual(reloads, [], 'no reload when the artifact could not be verified on disk');
      } finally {
        restore();
        delete process.env.FAKE_SCHEMA_FILE;
        delete process.env.FAKE_WASM_NO_ARTIFACT;
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// ── dylib 타깃 오케스트레이션 (native hot-core 설계 2026-09-09) ──────────────
//
// wasm 과 같은 runConfigDev 배선(codegen → 빌드 → 게이트 → 발행 → reload)이 dylib
// 타깃에서도 성립함을 증명한다. tauri 레이아웃(seedDylibProject — reactNative 섹션
// 없음)으로 심는다: dylib 의 주 고객은 tauri 앱이고, codegen 기본 경로(단일 패키지 +
// generate bin)만 요구하면 충분하다. fake cargo 의 build 는 --message-format=json
// 모드에서 compiler-artifact 줄을 stdout 으로 낸다 — 헬퍼가 산출물 경로를 "수신"하는
// 계약의 대역이다.
//
// 발행 계약: 빌드는 cargo 타깃 경로(스크래치)에만 닿고, 감시자가 폴링하는 라이브
// 경로(<stem>-hot-live<ext>)는 게이트 통과 빌드만 원자적으로 발행된다. RUSTRA_HOT_CORE
// 힌트는 라이브 경로만 가리킨다. $FAKE_DYLIB_CONTENT 로 빌드 바이트를 바꿀 수 있어
// "드리프트된 빌드가 라이브에 닿지 않았다"를 바이트 단위로 증명한다.

function hostDylibFileName(libName: string): string {
  if (process.platform === 'win32') return `${libName}.dll`;
  if (process.platform === 'linux') return `lib${libName}.so`;
  return `lib${libName}.dylib`;
}

/** 게이트 통과 발행 대상 라이브 파일명 — stem + `-hot-live` + 같은 확장자. */
function liveDylibFileName(libName: string): string {
  const base = hostDylibFileName(libName);
  const dot = base.lastIndexOf('.');
  return `${base.slice(0, dot)}-hot-live${base.slice(dot)}`;
}

function seedDylibProject(root: string): string {
  const project = join(root, 'proj');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'generated'), { recursive: true });
  mkdirSync(join(root, FAKE_BIN), { recursive: true });
  writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
  writeFileSync(join(project, 'src', 'lib.rs'), 'fn main() {}\n');
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 'proj', workspaces: [], dependencies: {} }),
  );
  writeFileSync(
    join(project, 'rustra.json'),
    JSON.stringify({
      schema: './generated/schema.json',
      output: './generated',
      tauri: {},
      dev: { target: 'dylib' },
    }),
  );
  const fakeCargo = [
    '#!/bin/bash',
    'if [ "$1" = "metadata" ]; then',
    '  manifest=""; prev=""',
    '  for a in "$@"; do [ "$prev" = "--manifest-path" ] && manifest="$a"; prev="$a"; done',
    '  dir=$(dirname "$manifest")',
    '  printf \'{"target_directory":"%s/target","packages":[{"name":"x","manifest_path":"%s",',
    '  "targets":[{"name":"generate","crate_types":["bin"],"kind":["bin"]},',
    '  {"name":"rustra_bridge","crate_types":["staticlib","cdylib"],"kind":["lib"]}]}]}\\n\' "$dir" "$manifest"',
    '  exit 0',
    'fi',
    'if [ "$1" = "run" ]; then',
    '  manifest=""; prev=""',
    '  for a in "$@"; do [ "$prev" = "--manifest-path" ] && manifest="$a"; prev="$a"; done',
    '  dir=$(dirname "$manifest")',
    '  mkdir -p "$dir/generated"',
    '  cp "$FAKE_SCHEMA_FILE" "$dir/generated/schema.json"',
    '  exit 0',
    'fi',
    'if [ "$1" = "build" ]; then',
    '  [ -n "$FAKE_DYLIB_LOG" ] && printf \'%s\\n\' "$*" >> "$FAKE_DYLIB_LOG"',
    '  if [ -n "$FAKE_DYLIB_FAIL" ]; then echo "fake dylib build failure" >&2; exit 3; fi',
    '  manifest=""; prev=""',
    '  for a in "$@"; do [ "$prev" = "--manifest-path" ] && manifest="$a"; prev="$a"; done',
    '  dir=$(dirname "$manifest")',
    '  out="$dir/target/debug"',
    '  mkdir -p "$out"',
    '  if [ -n "$FAKE_DYLIB_NO_ARTIFACT" ]; then',
    '    printf \'%s\\n\' "{\\"reason\\":\\"compiler-artifact\\",\\"filenames\\":[\\"$out/librustra_bridge.rmeta\\"],\\"target\\":{\\"kind\\":[\\"lib\\"]}}"',
    '    exit 0',
    '  fi',
    '  printf \'%s\\n\' "{\\"reason\\":\\"compiler-artifact\\",\\"filenames\\":[\\"$out/librustra_bridge.dylib\\",\\"$out/librustra_bridge.so\\",\\"$out/rustra_bridge.dll\\"],\\"target\\":{\\"kind\\":[\\"cdylib\\"]}}"',
    '  core="${FAKE_DYLIB_CONTENT:-fake dylib core}"',
    '  printf \'%s\' "$core" > "$out/librustra_bridge.dylib"',
    '  printf \'%s\' "$core" > "$out/librustra_bridge.so"',
    '  printf \'%s\' "$core" > "$out/rustra_bridge.dll"',
    '  exit 0',
    'fi',
    'echo "unexpected cargo invocation: $*" >&2',
    'exit 1',
  ].join('\n');
  const fakePath = join(root, FAKE_BIN, 'cargo');
  writeFileSync(fakePath, fakeCargo);
  chmodSync(fakePath, 0o755);
  return project;
}

test(
  'runConfigDev dylib target builds the cdylib core, announces RUSTRA_HOT_CORE, and reloads',
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-'));
    const originalPath = process.env.PATH;
    try {
      const project = seedDylibProject(root);
      writeSchema(join(project, 'generated', 'schema.json'), 'string');
      writeSchema(join(root, 'schema-string.json'), 'string');
      const dylibLog = join(root, 'dylib-build.log');
      process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
      process.env.FAKE_SCHEMA_FILE = join(root, 'schema-string.json');
      process.env.FAKE_DYLIB_LOG = dylibLog;

      const errors: string[] = [];
      const restore = captureConsole(errors);
      try {
        const handle = await runDev(['--config', join(project, 'rustra.json')]);
        const reloads: string[] = [];
        handle.onReload((reason) => void reloads.push(reason));

        // initial 강제 런이 codegen(cargo run)에 이어 cdylib 빌드(cargo build)를
        // 오케스트레이션한다 — runDev 반환 시점에 빌드 기록·아티팩트 안내·호스트
        // 실행 안내(RUSTRA_HOT_CORE)가 모두 있어야 한다. 산출물은 cargo 메시지가
        // 알려준 target/debug 경로 그대로다.
        const artifactPath = join('target', 'debug', hostDylibFileName('rustra_bridge'));
        const livePath = join('target', 'debug', liveDylibFileName('rustra_bridge'));
        const builds = readFileSync(dylibLog, 'utf8');
        assert.ok(
          builds.split('\n').some((line) => line.includes('--lib')),
          `cargo build must target the lib (cdylib), got:\n${builds}`,
        );
        assert.ok(
          builds.split('\n').some((line) => line.includes('--message-format=json')),
          `the artifact path is discovered from compiler-artifact JSON, got:\n${builds}`,
        );
        assert.ok(
          errors.some(
            (line) => line.includes('[dev:dylib] core artifact:') && line.includes(artifactPath),
          ),
          `the core artifact path must be announced, got:\n${errors.join('\n')}`,
        );
        // RUSTRA_HOT_CORE 힌트는 게이트 통과 발행 대상인 라이브 경로만 가리킨다 —
        // 무게이트 cargo 타깃 경로(스크래치)를 가리키면 드리프트 빌드가 그대로 스왑
        // 되는 구멍이 다시 열린다.
        assert.ok(
          errors.some((line) => line.includes('RUSTRA_HOT_CORE=') && line.includes(livePath)),
          `the host launch hint must carry the gated live path, got:\n${errors.join('\n')}`,
        );
        assert.ok(
          !errors.some((line) => line.includes('RUSTRA_HOT_CORE=') && line.includes(artifactPath)),
          'the hint must never point at the ungated cargo artifact path',
        );
        // 발행 계약 — initial 런(게이트 통과)이 라이브 경로에 원자적 발행돼 있고
        // tmp 잔여물이 없어야 한다.
        assert.equal(
          readFileSync(join(project, livePath), 'utf8'),
          'fake dylib core',
          'the gated publish must land the built bytes at the live path',
        );
        assert.deepEqual(
          readdirSync(join(project, 'target', 'debug')).filter((entry) => entry.includes('-tmp-')),
          [],
          'the atomic publish must not leave tmp files behind',
        );

        // 이어지는 변경도 codegen → dylib 빌드 → reload 순서로 계속된다(게이트가
        // 같은 계약을 유지하므로 reload 는 통과한다 — dylib 도 게이트 기본 on).
        await triggerUntil(
          () => errors,
          () => writeFileSync(join(project, 'src', 'lib.rs'), 'fn changed() {}\n'),
          () => reloads.length >= 1,
          'a reload after the dylib build',
        );
        handle.dispose();
        assert.ok(
          reloads.length >= 1,
          `reload must still fire after a successful dylib build, captured:\n${errors.join('\n')}`,
        );
        const buildsAfter = readFileSync(dylibLog, 'utf8');
        assert.ok(
          buildsAfter.split('\n').filter((line) => line.includes('--lib')).length >= 2,
          'every dirty run rebuilds the hot core, not just the initial one',
        );
      } finally {
        restore();
        delete process.env.FAKE_SCHEMA_FILE;
        delete process.env.FAKE_DYLIB_LOG;
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'runConfigDev dylib target rejects a drifted contract without emitting reload',
  { timeout: 30_000 },
  async () => {
    // dylib 도 wasm 과 같은 게이트다(2026-09-09 설계 — 무조정 스왑 거부는 CLI
    // 소재를 유지). 스키마 드리프트 시 reload 자체가 방출되지 않는다 — 앱이 구
    // 엔진을 유지하는 fail-closed. dylib + parityGate 기본값에서의 거부 배선이 이
    // 테스트의 대상이다.
    const root = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-parity-'));
    const originalPath = process.env.PATH;
    try {
      const project = seedDylibProject(root);
      writeSchema(join(project, 'generated', 'schema.json'), 'string');
      writeSchema(join(root, 'schema-string.json'), 'string');
      writeSchema(join(root, 'schema-integer.json'), 'integer');
      process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
      process.env.FAKE_SCHEMA_FILE = join(root, 'schema-string.json');

      const errors: string[] = [];
      const restore = captureConsole(errors);
      try {
        const handle = await runDev(['--config', join(project, 'rustra.json')]);
        const reloads: string[] = [];
        handle.onReload((reason) => void reloads.push(reason));

        // 시작점 — initial 런(게이트 통과)이 라이브에 발행한 상태다.
        const liveAbs = join(project, 'target', 'debug', liveDylibFileName('rustra_bridge'));
        assert.equal(readFileSync(liveAbs, 'utf8'), 'fake dylib core');

        // 트리거 — fake cargo 가 integer 계약과 **다른 바이트**의 코어를 빌드한다 →
        // 게이트가 거부해야 한다.
        process.env.FAKE_SCHEMA_FILE = join(root, 'schema-integer.json');
        process.env.FAKE_DYLIB_CONTENT = 'drifted core bytes';
        await triggerUntil(
          () => errors,
          () => writeFileSync(join(project, 'src', 'lib.rs'), 'fn changed() {}\n'),
          () =>
            errors.some(
              (line) => line.includes('[dev] reload rejected —') && line.includes('drift'),
            ),
          'the loud drift rejection on the dylib target',
        );
        await sleep(300);
        handle.dispose();
        assert.deepEqual(
          reloads,
          [],
          'a drifted dylib swap must not emit reload — the host keeps the old core',
        );
        // fail-closed 발행 — 드리프트된 빌드는 cargo 타깃 경로(스크래치)에 기록됐지만
        // 라이브 경로는 건드리지 않는다. 이전 발행물이 계속 스왑 대상이다.
        assert.equal(
          readFileSync(liveAbs, 'utf8'),
          'fake dylib core',
          'the drifted build must not reach the live path — the previously published core stays',
        );
        assert.equal(
          readFileSync(
            join(project, 'target', 'debug', hostDylibFileName('rustra_bridge')),
            'utf8',
          ),
          'drifted core bytes',
          'the drifted build did run — it only ever landed on the cargo scratch path',
        );
        assert.ok(
          errors.some(
            (line) =>
              line.includes('[dev:dylib] gated live artifact untouched') &&
              line.includes(liveDylibFileName('rustra_bridge')),
          ),
          `the rejection must state the live artifact was left untouched, got:\n${errors.join('\n')}`,
        );
        assert.ok(
          errors.some((line) =>
            line.includes('the host keeps running the previously published core'),
          ),
          `the rejection must state the consequence (the host keeps the old core), got:\n${errors.join('\n')}`,
        );
        assert.deepEqual(
          readdirSync(join(project, 'target', 'debug')).filter((entry) => entry.includes('-tmp-')),
          [],
          'the rejected run must not leave tmp files behind',
        );
      } finally {
        restore();
        delete process.env.FAKE_SCHEMA_FILE;
        delete process.env.FAKE_DYLIB_CONTENT;
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'runConfigDev dylib target publishes the new core once the re-armed baseline accepts the settled state',
  { timeout: 30_000 },
  async () => {
    // (b)→(c) 경계의 후반부 — 거부는 기준을 관찴된(코드젠된) 상태로 재무장하므로,
    // 스키마가 안정된 다음 런은 게이트를 통과하고 새 계약의 코어가 라이브로 발행된다
    // (reload 도 이때 처음 방출된다). 기존 drift 테스트가 거부에서 끝나고 통과
    // 테스트는 애초 안정 계약뿐이라, "거부 후 재발행" 절반이 갭이었다.
    const root = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-rearm-'));
    const originalPath = process.env.PATH;
    try {
      const project = seedDylibProject(root);
      writeSchema(join(project, 'generated', 'schema.json'), 'string');
      writeSchema(join(root, 'schema-string.json'), 'string');
      writeSchema(join(root, 'schema-integer.json'), 'integer');
      process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
      process.env.FAKE_SCHEMA_FILE = join(root, 'schema-string.json');

      const errors: string[] = [];
      const restore = captureConsole(errors);
      try {
        const handle = await runDev(['--config', join(project, 'rustra.json')]);
        const reloads: string[] = [];
        handle.onReload((reason) => void reloads.push(reason));

        // 시작점 — initial 런(게이트 통과)이 라이브에 발행한 상태다.
        const liveAbs = join(project, 'target', 'debug', liveDylibFileName('rustra_bridge'));
        assert.equal(readFileSync(liveAbs, 'utf8'), 'fake dylib core');

        // (b) 드리프트 런 — integer 계약 + 새 바이트의 코어 → 거부. 라이브는 구
        // 발행물을 유지하고 reload 는 방출되지 않는다(앞 테스트와 같은 절반).
        process.env.FAKE_SCHEMA_FILE = join(root, 'schema-integer.json');
        process.env.FAKE_DYLIB_CONTENT = 'drifted core bytes';
        await triggerUntil(
          () => errors,
          () => writeFileSync(join(project, 'src', 'lib.rs'), 'fn changed() {}\n'),
          () => errors.some((line) => line.includes('[dev] reload rejected —') && line.includes('drift')),
          'the loud drift rejection',
        );
        await sleep(300);
        assert.deepEqual(reloads, [], 'the drifted run must not emit reload');
        assert.equal(
          readFileSync(liveAbs, 'utf8'),
          'fake dylib core',
          'the rejection must leave the previously published core in place',
        );

        // (c) 코드젠이 따라잡은 뒤의 다음 런 — 스키마(integer)는 이제 (b) 거부에서
        // 재무장된 기준과 같고 코어 바이트도 같은 새 계약 → 통과 + 재발행 + reload.
        await triggerUntil(
          () => errors,
          () => writeFileSync(join(project, 'src', 'lib.rs'), 'fn caughtUp() {}\n'),
          () => reloads.length >= 1,
          'the re-armed passing run',
        );
        handle.dispose();
        assert.equal(
          readFileSync(liveAbs, 'utf8'),
          'drifted core bytes',
          'the settled run must atomically republish the new contract core to the live path',
        );
        const hints = errors.filter(
          (line) => line.includes('RUSTRA_HOT_CORE=') && line.includes(liveDylibFileName('rustra_bridge')),
        );
        assert.ok(
          hints.length >= 2,
          `the stable run must re-announce RUSTRA_HOT_CORE for the live path, got:\n${errors.join('\n')}`,
        );
        assert.ok(
          !readdirSync(join(project, 'target', 'debug')).some((entry) => entry.includes('-tmp-')),
          'the republish must not leave tmp files behind',
        );
      } finally {
        restore();
        delete process.env.FAKE_SCHEMA_FILE;
        delete process.env.FAKE_DYLIB_CONTENT;
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'runConfigDev dylib target leaves no live artifact when the gate rejects before the first publish',
  { timeout: 30_000 },
  async () => {
    // 첫 발행 전 거부 — 라이브 파일이 아직 없다. initial 런의 빌드를 실패시켜
    // (FAKE_DYLIB_FAIL) 발행 없이 게이트만 무장한 상태를 만든 뒤, 드리프트 트리거로
    // 거부를 유도한다. 이 상태의 거부는 "라이브가 발행된 적 없다"와 "호스트를 띄우면
    // 안 된다"를 loud 하게 말해야 하고, 어떤 발행·reload 도 일어나지 않는다.
    const root = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-firstrej-'));
    const originalPath = process.env.PATH;
    try {
      const project = seedDylibProject(root);
      writeSchema(join(project, 'generated', 'schema.json'), 'string');
      writeSchema(join(root, 'schema-string.json'), 'string');
      writeSchema(join(root, 'schema-integer.json'), 'integer');
      process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
      process.env.FAKE_SCHEMA_FILE = join(root, 'schema-string.json');
      process.env.FAKE_DYLIB_FAIL = '1';

      const errors: string[] = [];
      const restore = captureConsole(errors);
      try {
        const handle = await runDev(['--config', join(project, 'rustra.json')]);
        const reloads: string[] = [];
        handle.onReload((reason) => void reloads.push(reason));

        const liveAbs = join(project, 'target', 'debug', liveDylibFileName('rustra_bridge'));
        // 시작점 — initial 런은 빌드 실패로 발행 없이 끝났다.
        assert.ok(
          !existsSync(liveAbs),
          'the failed initial build must not publish a live artifact',
        );

        // 트리거 — 빌드는 이제 성공하지만 계약이 드리프트됐다 → 첫 발행 전 거부.
        delete process.env.FAKE_DYLIB_FAIL;
        process.env.FAKE_SCHEMA_FILE = join(root, 'schema-integer.json');
        await triggerUntil(
          () => errors,
          () => writeFileSync(join(project, 'src', 'lib.rs'), 'fn changed() {}\n'),
          () =>
            errors.some(
              (line) => line.includes('[dev] reload rejected —') && line.includes('drift'),
            ),
          'the first-publish drift rejection',
        );
        await sleep(300);
        handle.dispose();
        assert.ok(
          !existsSync(liveAbs),
          'a gate rejection before the first publish must not create the live artifact',
        );
        assert.ok(
          errors.some(
            (line) =>
              line.includes('[dev:dylib] no gated live artifact was published') &&
              line.includes('do not launch the host'),
          ),
          `the rejection must state no live artifact exists and the host must not be launched, ` +
            `got:\n${errors.join('\n')}`,
        );
        assert.deepEqual(
          reloads,
          [],
          'no reload may be emitted when the first publish never happened',
        );
      } finally {
        restore();
        delete process.env.FAKE_SCHEMA_FILE;
        delete process.env.FAKE_DYLIB_FAIL;
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'runConfigDev dylib target fails loudly when the crate declares no cdylib',
  { timeout: 30_000 },
  async () => {
    // crate-type "cdylib" 강제 — 핫스왑 단위가 없으면 빌드 "성공"이어도 reload 는
    // 없어야 한다. 에러는 cdylib 원인과 crate-type 힌트를 함께 말한다.
    const root = mkdtempSync(join(tmpdir(), 'rustra-dev-dylib-nocdylib-'));
    const originalPath = process.env.PATH;
    try {
      const project = seedDylibProject(root);
      writeSchema(join(project, 'generated', 'schema.json'), 'string');
      writeSchema(join(root, 'schema-string.json'), 'string');
      process.env.PATH = `${join(root, FAKE_BIN)}:${originalPath}`;
      process.env.FAKE_SCHEMA_FILE = join(root, 'schema-string.json');
      process.env.FAKE_DYLIB_NO_ARTIFACT = '1';

      const errors: string[] = [];
      const restore = captureConsole(errors);
      try {
        const handle = await runDev(['--config', join(project, 'rustra.json')]);
        const reloads: string[] = [];
        handle.onReload((reason) => void reloads.push(reason));
        await sleep(300);
        handle.dispose();
        const failure = errors.find((line) => line.includes('[dev] regeneration failed'));
        assert.ok(failure, `the missing-cdylib case must be loud, got:\n${errors.join('\n')}`);
        assert.match(failure, /cdylib/, 'the error must name cdylib as the cause');
        assert.match(
          failure,
          /crate-type/,
          'the error must include the crate-type "cdylib" fix hint',
        );
        assert.ok(
          !errors.some((line) => line.includes('[dev:dylib] core artifact:')),
          'no artifact announcement without a cdylib target',
        );
        assert.deepEqual(reloads, [], 'no reload when the hot core cannot be built');
      } finally {
        restore();
        delete process.env.FAKE_SCHEMA_FILE;
        delete process.env.FAKE_DYLIB_NO_ARTIFACT;
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

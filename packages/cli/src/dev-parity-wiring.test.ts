import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDev } from './dev.js';

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

function seedProject(root: string): string {
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
  writeFileSync(
    join(project, 'rustra.json'),
    JSON.stringify({
      schema: './generated/schema.json',
      output: './generated',
      reactNative: { moduleDir: './modules' },
      dev: { target: 'wasm', wasm: { engine: 'wasm3' } },
    }),
  );
  const fakeCargo = [
    '#!/bin/bash',
    'if [ "$1" = "metadata" ]; then',
    '  manifest=""; prev=""',
    '  for a in "$@"; do [ "$prev" = "--manifest-path" ] && manifest="$a"; prev="$a"; done',
    '  dir=$(dirname "$manifest")',
    '  printf \'{"target_directory":"%s/target","packages":[{"name":"x","manifest_path":"%s",',
    '"targets":[{"name":"generate","crate_types":["bin"],"kind":["bin"]},',
    '{"name":"rustra_bridge","crate_types":["staticlib"],"kind":["lib"]}]}]}\\n\' "$dir" "$manifest"',
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
    'echo "unexpected cargo invocation: $*" >&2',
    'exit 1',
  ].join('\n');
  const fakePath = join(root, FAKE_BIN, 'cargo');
  writeFileSync(fakePath, fakeCargo);
  chmodSync(fakePath, 0o755);
  return project;
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
      const originalError = console.error;
      const originalLog = console.log;
      console.error = (line: unknown) => errors.push(String(line));
      console.log = (line: unknown) => errors.push(`LOG ${String(line)}`);
      // watch → debounce → codegen → verify 왕복은 풀스위트 부하 하에서 들쭉날쭉
      // 하다 — 고정 sleep 대신 관찰 조건을 폴링한다(디바운스 상수와 무관하게
      // 안정적). 타임아웃은 실패 시점까지 캡처한 로그를 그대로 보여준다.
      const waitFor = async (observe: () => boolean, what: string): Promise<void> => {
        const deadline = Date.now() + 10_000;
        while (!observe()) {
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}; captured:\n${errors.join('\n')}`);
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      };
      const rejectionCount = (): number =>
        errors.filter((line) => line.includes('[dev] reload rejected —')).length;
      try {
        const handle = await runDev(['--config', join(project, 'rustra.json')]);
        const reloads: string[] = [];
        handle.onReload((reason) => void reloads.push(reason));

        // 트리거 1 — fake cargo 가 integer 계약을 쓴다 → 게이트가 거부해야 한다.
        // 거부 로그 자체가 "판정이 돌았다"는 양(陽) 관찰이자 동기화점이다.
        process.env.FAKE_SCHEMA_FILE = join(root, 'schema-integer.json');
        writeFileSync(join(project, 'src', 'lib.rs'), 'fn changed() {}\n');
        await waitFor(
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
        writeFileSync(join(project, 'src', 'lib.rs'), 'fn changed2() {}\n');
        await waitFor(() => rejectionCount() >= 2, 'the second (restored-contract) rejection');

        // 두 번째 판정이 관찰된 뒤 짧은 유예 — 이 안에 reload 가 방출되지
        // 않았음이 곧 부정(i) 검증이다(거부는 reload 를 방출하지 않는다).
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        handle.dispose();
        assert.ok(rejectionCount() >= 2, `rejection must be loud, got: ${errors.join('\n')}`);
        assert.deepEqual(
          reloads,
          [],
          'drifted reload must not be emitted; the restored contract is also re-verified ' +
            '(baseline re-armed to the drifted state), so both triggers are rejected',
        );
      } finally {
        console.error = originalError;
        console.log = originalLog;
        delete process.env.FAKE_SCHEMA_FILE;
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

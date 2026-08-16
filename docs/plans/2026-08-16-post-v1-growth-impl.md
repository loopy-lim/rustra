# Post-0.1.1 Growth Tracks Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 메인 트랙 3스프린트(hot-reload `rustra dev`, `@rustra/testing`, `@rustra/devtools`) + 백그라운드 트랙(Windows CI 실험, FFI 퍼징)을 구현한다.

**Architecture:** hot-reload는 기존 자산 3종(debug 런타임 레지스트리 `Package::register/replace`, `rustra generate --watch`, dual-path `codegen.sh`)을 하나의 `rustra dev` CLI로 묶되, **실행 중 프로세스 무중단 주입은 scope-out**하고 "재빌드+재생성+게이트 재실행" 루프로 증명한다(레지스트리 주입 경로는 별트랙). 테스팅/devtools는 각각 독립 npm 패키지(`packages/testing`, `packages/devtools`)로, 핵심 타입(`EngineClient`, `RustraCommandError`)은 `@rustra/types`를 재사용한다. 백그라운드 트랙은 독립 CI 워크플로 2종(`windows-experiment.yml`, `fuzz.yml`)로 본 머신을 점유하지 않게 한다.

**Tech Stack:** TypeScript 5.9 (NodeNext), node:test, Rust 1.95 (rustra crate), cargo-fuzz, GitHub Actions (windows-latest).

**설계 문서:** `docs/plans/2026-08-16-post-v1-growth-design.md`

---

## Sprint 1 — Hot-reload / live codegen (`rustra dev`)

### 배경 지식 (실행자용)

- **dual-path codegen**: 생성 파일은 두 경로로 나뉜다.
  1. Rust bin (`backend/src/bin/generate.rs`) → `types.ts`/`commands.ts`/`contract.ts`/`schema.json`
  2. TS CLI (`packages/cli`) → `rkyv-codecs.ts`/`rkyv-registry.ts`
     한쪽만 돌리면 stale → `runner/template/codegen.sh`가 둘 다 순서대로 실행한다.
- **watch의 사각**: `rustra generate --watch`는 schema.json 파일 변경만 감시한다. schema.json은 **Rust bin을 실행해야** 갱신되므로, Rust 소스 수정 → schema.json 재생성 → TS 재생성 순으로 수동 2단계다. `rustra dev`가 이 간극을 메운다.
- **런타임 레지스트리**: debug 빌드에서 `Package::register/replace/unregister`가 동작(release는 freeze). 본 스프린트에서는 **코드 레벨 검증만** 사용하고 프로세스 무중단 주입은 하지 않는다.

### Task 1: `rustra dev` 서브커맨드 — Rust 소스 감시 + codegen 파이프라인 재실행

**Files:**

- Create: `packages/cli/src/dev.ts` (신규 모듈)
- Modify: `packages/cli/src/index.ts` (서브커맨드 분기 + help)
- Test: `packages/cli/src/dev.test.ts`

**Step 1: 실패 테스트 작성 — 인자 파싱과 재생성 플래그 계산**

`packages/cli/src/dev.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDevArgs, planPipeline } from './dev.js';

test('parseDevArgs parses backend dir and app dir', () => {
  const opts = parseDevArgs(['--backend', './backend', '--app', './app']);
  assert.equal(opts.backendDir, './backend');
  assert.equal(opts.appDir, './app');
});

test('parseDevArgs defaults to conventional layout', () => {
  const opts = parseDevArgs([]);
  assert.equal(opts.backendDir, 'backend');
  assert.equal(opts.appDir, 'app');
});

test('planPipeline reports which stages are dirty after a rust-only change', () => {
  // rust 소스가 schema.json 보다 새면: rust_codegen 필요 → schema 변경 → ts_codegen 필요
  const plan = planPipeline({
    rustNewerThanSchema: true,
    codecsStaleAgainstSchema: false,
  });
  assert.equal(plan.rustBin, true);
  assert.equal(plan.tsCli, true);
});

test('planPipeline skips rust bin when only codecs are stale', () => {
  const plan = planPipeline({ rustNewerThanSchema: false, codecsStaleAgainstSchema: true });
  assert.equal(plan.rustBin, false);
  assert.equal(plan.tsCli, true);
});
```

**Step 2: 실행해 실패 확인**

Run: `cd packages/cli && npx tsc -p tsconfig.test.json && node --test dist-test/dev.test.js`
Expected: FAIL — `Cannot find module './dev.js'`

**Step 3: 최소 구현 — `packages/cli/src/dev.ts`**

```ts
import { resolve } from 'node:path';

export interface DevOptions {
  backendDir: string;
  appDir: string;
}

export function parseDevArgs(args: string[]): DevOptions {
  const get = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1];
  };
  return {
    backendDir: get('backend') ?? 'backend',
    appDir: get('app') ?? 'app',
  };
}

export interface PipelinePlan {
  rustBin: boolean;
  tsCli: boolean;
}

export function planPipeline(dirty: {
  rustNewerThanSchema: boolean;
  codecsStaleAgainstSchema: boolean;
}): PipelinePlan {
  return {
    // rust 소스가 새면 schema 재생성 필요 → schema 가 바뀌면 ts cli 재생성 필요
    rustBin: dirty.rustNewerThanSchema,
    tsCli: dirty.rustNewerThanSchema || dirty.codecsStaleAgainstSchema,
  };
}
```

**Step 4: 테스트 통과 확인**

Run: `cd packages/cli && npx tsc -p tsconfig.test.json && node --test dist-test/dev.test.js`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add packages/cli/src/dev.ts packages/cli/src/dev.test.ts
git commit -m "feat(cli): rustra dev 인자 파싱/파이프라인 플래그 — TDD 씨앗"
```

### Task 2: stale 감지 — mtime 비교로 dirty 판정

**Files:**

- Modify: `packages/cli/src/dev.ts`
- Modify: `packages/cli/src/dev.test.ts`

**Step 1: 실패 테스트 추가 — 임시 디렉토리로 stale 감지**

`packages/cli/src/dev.test.ts`에 추가:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectDirty } from './dev.js';

test('detectDirty: rust src newer than schema.json → rustNewerThanSchema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-'));
  try {
    const backend = join(dir, 'backend');
    const generated = join(dir, 'app', 'generated');
    mkdirSync(join(backend, 'src'), { recursive: true });
    mkdirSync(generated, { recursive: true });
    writeFileSync(join(backend, 'src', 'lib.rs'), 'x');
    const schema = join(generated, 'schema.json');
    writeFileSync(schema, '{}');
    // rust 를 1초 뒤로, schema 를 과거로
    utimesSync(join(backend, 'src', 'lib.rs'), new Date(), new Date('2026-08-16T12:00:01Z'));
    utimesSync(schema, new Date(), new Date('2026-08-16T12:00:00Z'));
    const dirty = detectDirty(backend, generated);
    assert.equal(dirty.rustNewerThanSchema, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectDirty: schema newer → not dirty (rust)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustra-dev-'));
  try {
    const backend = join(dir, 'backend');
    const generated = join(dir, 'app', 'generated');
    mkdirSync(join(backend, 'src'), { recursive: true });
    mkdirSync(generated, { recursive: true });
    writeFileSync(join(backend, 'src', 'lib.rs'), 'x');
    const schema = join(generated, 'schema.json');
    writeFileSync(schema, '{}');
    utimesSync(join(backend, 'src', 'lib.rs'), new Date(), new Date('2026-08-16T12:00:00Z'));
    utimesSync(schema, new Date(), new Date('2026-08-16T12:00:05Z'));
    const dirty = detectDirty(backend, generated);
    assert.equal(dirty.rustNewerThanSchema, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

**Step 2: 실행해 실패 확인**

Run: `cd packages/cli && npx tsc -p tsconfig.test.json && node --test dist-test/dev.test.js`
Expected: FAIL — `detectDirty` 내보내기 없음

**Step 3: 구현 — dev.ts에 추가**

```ts
import { readdirSync, statSync, existsSync } from 'node:fs';

/** dir 트리에서 가장 최신 mtime (재귀, node_modules/target/dist 제외). */
function newestMtime(dir: string): number {
  let newest = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === 'dist') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(p));
    } else {
      newest = Math.max(newest, statSync(p).mtimeMs);
    }
  }
  return newest;
}

/** codegen 재실행 판정에 필요한 stale 상태. */
export function detectDirty(
  backendDir: string,
  generatedDir: string,
): {
  rustNewerThanSchema: boolean;
  codecsStaleAgainstSchema: boolean;
} {
  const schemaPath = join(generatedDir, 'schema.json');
  const schemaMtime = existsSync(schemaPath) ? statSync(schemaPath).mtimeMs : 0;
  const rustNewest = newestMtime(join(backendDir, 'src'));
  const codecsNewest = Math.max(
    ...['rkyv-codecs.ts', 'rkyv-registry.ts'].map((f) => {
      const p = join(generatedDir, f);
      return existsSync(p) ? statSync(p).mtimeMs : 0;
    }),
  );
  return {
    rustNewerThanSchema: rustNewest > schemaMtime,
    codecsStaleAgainstSchema: schemaMtime > codecsNewest,
  };
}
```

(파일 상단 import에 `join` 추가: `import { resolve, join } from 'node:path';`)

**Step 4: 테스트 통과 확인**

Run: `cd packages/cli && npx tsc -p tsconfig.test.json && node --test dist-test/dev.test.js`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add packages/cli/src/dev.ts packages/cli/src/dev.test.ts
git commit -m "feat(cli): rustra dev stale 감지 — mtime 기반 dual-path dirty 판정"
```

### Task 3: 파이프라인 실행기 — cargo 재빌드 감시 루프와 watch 통합

**Files:**

- Modify: `packages/cli/src/dev.ts` (runDev 엔트리)
- Modify: `packages/cli/src/index.ts` (서브커맨드 분기 + help 텍스트)
- Test: `packages/cli/src/dev.test.ts` (실행기 계약 테스트만 — 실 루프는 통합 검증)

**Step 1: 실패 테스트 — 실행기가 스테이지를 순서대로 호출**

`packages/cli/src/dev.test.ts`에 추가:

```ts
import { runOnce } from './dev.js';

test('runOnce executes dirty stages in order and skips clean ones', async () => {
  const calls: string[] = [];
  await runOnce(
    { rustBin: true, tsCli: false },
    {
      rustBin: async () => void calls.push('rust'),
      tsCli: async () => void calls.push('ts'),
    },
  );
  assert.deepEqual(calls, ['rust']);
});
```

**Step 2: 실행해 실패 확인**

Run: `cd packages/cli && npx tsc -p tsconfig.test.json && node --test dist-test/dev.test.js`
Expected: FAIL — `runOnce` 없음

**Step 3: 구현 — dev.ts에 실행기 + 실 파이프라인 추가**

```ts
export interface StageRunners {
  rustBin: () => Promise<void>;
  tsCli: () => Promise<void>;
}

/** plan 이 지정한 스테이지만 순서대로 실행 (rust → ts). */
export async function runOnce(plan: PipelinePlan, runners: StageRunners): Promise<void> {
  if (plan.rustBin) await runners.rustBin();
  if (plan.tsCli) await runners.tsCli();
}

import { spawn } from 'node:child_process';
import { watch } from 'node:fs';

function spawnInherit(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${cmd} exit ${code}`)),
    );
    child.on('error', reject);
  });
}

export async function runDev(args: string[]): Promise<void> {
  const opts = parseDevArgs(args);
  const backendDir = resolve(opts.backendDir);
  const appDir = resolve(opts.appDir);
  const generatedDir = join(appDir, 'generated');

  const rustBin = () => spawnInherit('cargo', ['run', '--quiet', '--bin', 'generate'], backendDir);
  const tsCli = async () => {
    // codegen.sh 탐색 정책 재사용: 명시 env > 상위 탐색
    const cli = process.env.RUSTRA_CLI ?? findRepoCli(resolve(appDir));
    if (!cli) {
      console.error('[dev] rustra CLI 를 찾을 수 없음 — RUSTRA_CLI env 지정 필요');
      return;
    }
    await spawnInherit(
      'node',
      [cli, 'generate', '--schema', join(generatedDir, 'schema.json'), '--output', generatedDir],
      appDir,
    );
  };

  const tick = async (reason: string) => {
    console.log(`[dev] ${reason} → codegen`);
    const dirty = detectDirty(backendDir, generatedDir);
    const plan = planPipeline(dirty);
    if (!plan.rustBin && !plan.tsCli) {
      console.log('[dev] clean — nothing to do');
      return;
    }
    try {
      await runOnce(plan, { rustBin, tsCli });
      console.log(`[dev] ${new Date().toLocaleTimeString()} regenerated`);
    } catch (e) {
      console.error(`[dev] regeneration failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  await tick('initial');
  console.log(`\n[dev] watching ${backendDir} for changes...`);
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(join(backendDir, 'src'), { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick('rust change'), 300);
  });
}

function findRepoCli(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    dir = dirname(dir);
    const candidate = join(dir, 'packages', 'cli', 'dist', 'index.js');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
```

(상단 import 정리: `dirname` 추가, `join`/`existsSync` 이미 사용 중)

**Step 4: index.ts 서브커맨드 분기**

`packages/cli/src/index.ts`의 `main()`에 `diff` 분기 뒤 추가:

```ts
if (args[0] === 'dev') {
  const { runDev } = await import('./dev.js');
  await runDev(args.slice(1));
  return;
}
```

`printHelp()`의 Usage/Options/Examples에 추가:

```
  rustra dev [--backend <dir>] [--app <dir>]
  --backend <dir>    (dev) Rust backend crate dir (default: ./backend)
  --app <dir>        (dev) App dir containing generated/ (default: ./app)
  rustra dev --backend runner/template/backend --app runner/template/app
```

**Step 5: 테스트 통과 + typecheck 확인**

Run: `cd packages/cli && npx tsc -p tsconfig.test.json && node --test dist-test/dev.test.js && npm run test`
Expected: PASS 전부 (신규 7 + 기존)

**Step 6: Commit**

```bash
git add packages/cli/src/dev.ts packages/cli/src/dev.test.ts packages/cli/src/index.ts
git commit -m "feat(cli): rustra dev — 소스 감시 + dual-path codegen 자동 루프"
```

### Task 4: 통합 검증 — runner 템플릿에서 실재작동 증명

**Files:**

- Modify: `runner/template/README.md` (dev 워크플로 절 추가)

**Step 1: 실동작 스파크테스트**

```bash
# 최초 1회: generated/ 생성
cd runner/template/app && npm install && npm run codegen
# 이후 루프: 별 터미널에서
RUSTRA_CLI=$PWD/packages/cli/dist/index.js node packages/cli/dist/index.js dev \
  --backend runner/template/backend --app runner/template/app
# 다른 터미널에서 backend/src/lib.rs 의 greet 메시지 수정 (예: "Hello, {name}!!")
# → [dev] regenerated 로그와 generated/schema.json 갱신 확인
# → (cd runner/template/app && npm run build) 로 번들 재빌드 성공 확인
```

Expected: greet 수정 → 자동 codegen → 번들 빌드 성공. 앱 프로세스 재시작 없이도 다음 실행에서 새 스키마/클라이언트 반영(무중단 주입은 별트랙이므로 빌드 전파까지만 증명).

**Step 2: README dev 절 작성** (위 절차를 문서화)

**Step 3: Commit**

```bash
git add runner/template/README.md
git commit -m "docs: runner 템플릿 rustra dev 워크플로"
```

---

## Sprint 2 — `@rustra/testing` 패키지

### 배경 지식

- 어댑터는 전부 `EngineClient = { invoke<T>(command, args?): Promise<T> }`만 구현하면 된다(`packages/types/src/index.ts:23`). mock 엔진도 같은 계약.
- 에러 래핑 관례(`packages/node/src/index.test.ts`): 핸들러가 `{code, message}` 모양으로 reject 하면 `RustraCommandError`로 변환해 전파.
- 패키지 레이아웃/manifest는 `packages/tauri`를 그대로 본뜬다(workspaces glob `packages/*`라 등록만으로 편입).

### Task 5: 패키지 스캐폴드 + createMockEngine 코어

**Files:**

- Create: `packages/testing/package.json`, `packages/testing/tsconfig.json`, `packages/testing/src/index.ts`, `packages/testing/src/index.test.ts`
- Modify: 루트 `package.json` (`test:packages` 스크립트에 `packages/testing/dist/index.test.js` 추가)

**Step 1: 실패 테스트 작성 — `packages/testing/src/index.test.ts`**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMockEngine } from './index.js';
import { RustraCommandError } from '@rustra/types';

test('mock engine invokes registered handler', async () => {
  const engine = createMockEngine();
  engine.on('addNumbers', ({ a, b }: { a: number; b: number }) => a + b);
  const result = await engine.invoke<number>('addNumbers', { a: 20, b: 22 });
  assert.equal(result, 42);
});

test('unknown command rejects with RustraCommandError command.not_found', async () => {
  const engine = createMockEngine();
  await assert.rejects(
    () => engine.invoke('missing'),
    (err: unknown) => err instanceof RustraCommandError && err.code === 'command.not_found',
  );
});

test('handler errors become RustraCommandError with custom code', async () => {
  const engine = createMockEngine();
  engine.on('fail', () => {
    throw { code: 'validation.too_large', message: 'value exceeds limit' };
  });
  await assert.rejects(
    () => engine.invoke('fail'),
    (err: unknown) => err instanceof RustraCommandError && err.code === 'validation.too_large',
  );
});

test('on returns engine for chaining', () => {
  const engine = createMockEngine();
  const returned = engine.on('x', () => 1);
  assert.equal(returned, engine);
});
```

**Step 2: 패키지 스캐폴드**

`packages/testing/package.json` (`packages/tauri/package.json` 참고해 작성, name `@rustra/testing`, description "Testing utilities for rustra-bridge", test 스크립트 `tsc -p tsconfig.test.json && node --test dist-test/index.test.js`):

`packages/testing/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
}
```

`packages/testing/tsconfig.test.json` (cli 것 복사 — outDir `./dist-test`).

**Step 3: 실행해 실패 확인**

Run: `cd packages/testing && npm install --no-save && npx tsc -p tsconfig.test.json && node --test dist-test/index.test.js`
Expected: FAIL — `createMockEngine` 없음

**Step 4: 구현 — `packages/testing/src/index.ts`**

```ts
import type { EngineClient, RustraCommandError as _E } from '@rustra/types';
import { RustraCommandError } from '@rustra/types';

type Handler = (args: unknown) => unknown;

export interface MockEngine extends EngineClient {
  on(command: string, handler: Handler): MockEngine;
  calls(): Array<{ command: string; args: unknown }>;
}

export function createMockEngine(): MockEngine {
  const handlers = new Map<string, Handler>();
  const log: Array<{ command: string; args: unknown }> = [];
  const engine: MockEngine = {
    on(command, handler) {
      handlers.set(command, handler);
      return engine;
    },
    calls: () => [...log],
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      log.push({ command, args });
      const handler = handlers.get(command);
      if (!handler) {
        throw new RustraCommandError('command.not_found', `no mock registered for '${command}'`);
      }
      try {
        return (await handler(args)) as T;
      } catch (e) {
        if (e instanceof RustraCommandError) throw e;
        if (isRustraErrorShape(e)) {
          throw new RustraCommandError(e.code, e.message, e.retryable);
        }
        throw new RustraCommandError('unknown', String(e));
      }
    },
  };
  return engine;
}

function isRustraErrorShape(
  e: unknown,
): e is { code: string; message: string; retryable?: boolean } {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    'message' in e &&
    typeof (e as { code: unknown }).code === 'string' &&
    typeof (e as { message: unknown }).message === 'string'
  );
}
```

(테스트가 handler 동기 throw 를 커버하므로 `await handler(args)`로 비동기/동기 둘 다 처리. 사용하지 않는 `_E` 타입 import는 제거하고 `EngineClient`만.)

**Step 5: 테스트 통과 확인**

Run: `cd packages/testing && npx tsc -p tsconfig.test.json && node --test dist-test/index.test.js`
Expected: PASS (4 tests)

**Step 6: 루트 test:packages 등록 + 전체 green 확인**

루트 `package.json` `test:packages`의 node --test 대상 목록에 `packages/testing/dist/index.test.js` 추가 후:

Run: `npm run build && npm run test:packages`
Expected: PASS (기존 24 + 신규 4)

**Step 7: Commit**

```bash
git add packages/testing package.json package-lock.json
git commit -m "feat(testing): @rustra/testing createMockEngine — 계약 동일 mock 엔진"
```

### Task 6: 계약 게이트 — schema.json 대비 생성 코드 정합성 검사

**Files:**

- Create: `packages/testing/src/contract-gate.ts`
- Modify: `packages/testing/src/index.ts` (export), `packages/testing/src/index.test.ts`

**Step 1: 실패 테스트 추가**

```ts
import { assertContractCurrent } from './contract-gate.js';
import { readFileSync } from 'node:fs';

test('assertContractCurrent passes when commands match', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../fixtures/schema.sample.json', import.meta.url), 'utf-8'),
  ) as { commands: Array<{ name: string }> };
  const ok = assertContractCurrent(schema, ['addNumbers', 'createItem']);
  assert.equal(ok.missingInClient, []);
  assert.equal(ok.missingInSchema, []);
});

test('assertContractCurrent detects drift both ways', () => {
  const schema = { commands: [{ name: 'addNumbers' }] };
  const result = assertContractCurrent(schema, ['addNumbers', 'staleCommand']);
  assert.deepEqual(result.missingInSchema, ['staleCommand']);
  assert.deepEqual(result.missingInClient, []);
});
```

(테스트 픽스처 `packages/testing/fixtures/schema.sample.json` — commands 배열에 `addNumbers`/`createItem` 이름만 있는 최소 JSON. `files` 필드에 `fixtures` 추가.)

**Step 2: 실행해 실패 확인** — 같은 패턴.

**Step 3: 구현 — `packages/testing/src/contract-gate.ts`**

```ts
/** schema.json 의 명령 목록과 클라이언트가 노출하는 명령 목록의 정합성. */
export function assertContractCurrent(
  schema: { commands: Array<{ name: string }> },
  clientCommands: string[],
): { missingInClient: string[]; missingInSchema: string[] } {
  const schemaNames = schema.commands.map((c) => c.name);
  const clientSet = new Set(clientCommands);
  return {
    missingInClient: schemaNames.filter((n) => !clientSet.has(n)),
    missingInSchema: clientCommands.filter((c) => !schemaNames.includes(c)),
  };
}
```

`index.ts`에 `export { assertContractCurrent } from './contract-gate.js';`

**Step 4: 테스트 통과 + Commit**

```bash
git add packages/testing
git commit -m "feat(testing): 계약 게이트 — schema.json 대비 클라이언트 명목 드리프트 검출"
```

---

## Sprint 3 — `@rustra/devtools` 패키지

### 배경 지식

- 측정은 JS 쪽 `Date.now()` 기반(QuickJS `performance.now` 부재 — memory 참고). 호스트(Rust) 정밀 측정은 이미 bench 자산이 담당하므로 JS 래퍼 퍼셉트 레벨로 충분.
- `createValidatedEngine`(`packages/cli/src/validate-engine.ts`)이 래퍼 패턴의 선례 — devtools도 같은 데코레이터 구조.

### Task 7: createInstrumentedEngine — 호출 로그/지연/에러 수집 래퍼

**Files:**

- Create: `packages/devtools/package.json`, `packages/devtools/tsconfig.json`, `packages/devtools/tsconfig.test.json`, `packages/devtools/src/index.ts`, `packages/devtools/src/index.test.ts`
- Modify: 루트 `package.json` (`test:packages`에 devtools 추가)

**Step 1: 실패 테스트 — `packages/devtools/src/index.test.ts`**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createInstrumentedEngine } from './index.js';

test('instrumented engine records calls, durations, errors', async () => {
  const inner = {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      if (command === 'fail') throw new Error('boom');
      return { echoed: args } as T;
    },
  };
  const engine = createInstrumentedEngine(inner);
  await engine.invoke('addNumbers', { a: 1 });
  await engine.invoke('addNumbers', { a: 2 });
  await engine.invoke('fail').catch(() => {});
  const report = engine.report();
  assert.equal(report.totalCalls, 3);
  assert.equal(report.commandStats.addNumbers.count, 2);
  assert.equal(report.commandStats.addNumbers.errors, 0);
  assert.equal(report.commandStats.fail.errors, 1);
  assert.ok(report.commandStats.addNumbers.avgMs >= 0);
});
```

**Step 2: 스캐폴드 + 실패 확인** — Task 5와 동일 패턴(`@rustra/devtools`).

**Step 3: 구현 — `packages/devtools/src/index.ts`**

```ts
import type { EngineClient } from '@rustra/types';

interface CommandStat {
  count: number;
  errors: number;
  totalMs: number;
}

export interface DevtoolsReport {
  totalCalls: number;
  commandStats: Record<string, CommandStat & { avgMs: number }>;
  slowest: Array<{ command: string; ms: number }>;
}

export interface InstrumentedEngine extends EngineClient {
  report(): DevtoolsReport;
}

export function createInstrumentedEngine(inner: EngineClient): InstrumentedEngine {
  const stats = new Map<string, CommandStat>();
  const slowest: Array<{ command: string; ms: number }> = [];
  let totalCalls = 0;

  const statFor = (command: string): CommandStat => {
    let s = stats.get(command);
    if (!s) {
      s = { count: 0, errors: 0, totalMs: 0 };
      stats.set(command, s);
    }
    return s;
  };

  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      const start = Date.now();
      try {
        return await inner.invoke<T>(command, args);
      } finally {
        const ms = Date.now() - start;
        const s = statFor(command);
        s.count += 1;
        s.totalMs += ms;
        totalCalls += 1;
        slowest.push({ command, ms });
      }
    },
    report(): DevtoolsReport {
      const commandStats: DevtoolsReport['commandStats'] = {};
      for (const [name, s] of stats) {
        commandStats[name] = { ...s, avgMs: s.count > 0 ? s.totalMs / s.count : 0 };
      }
      slowest.sort((a, b) => b.ms - a.ms);
      return {
        totalCalls,
        commandStats,
        slowest: slowest.slice(0, 10),
      };
    },
  };
}
```

주의: 에러 카운팅을 위해서는 `finally` 안에서 성공/실패 구분이 필요하다 — 실제 구현은 `catch`에서 `s.errors += 1` 후 rethrow, `finally`에서 duration/count 누적하는 구조로 정확히 작성할 것 (위 스켈레톤의 의도 전달용).

**Step 4: 테스트 통과 + test:packages 등록 + Commit**

```bash
git add packages/devtools package.json package-lock.json
git commit -m "feat(devtools): @rustra/devtools createInstrumentedEngine — 호출 관측성"
```

### Task 8: `rustra dev --inspect` 연결점

**Files:**

- Modify: `packages/cli/src/dev.ts`

**Step 1: 구현** — `runDev`가 `--inspect` 플래그를 받으면, codegen tick 후 `InstrumentedEngine` 사용을 안내하는 주석과 함께 app 측 `@rustra/devtools` 로드 가이드를 로그로 출력 (JS 프로세스가 CLI와 다르므로 in-process 연결은 불가 — 로그 기반 안내가 정직한 범위):

```ts
// parseDevArgs 에 inspect?: boolean 추가 (--inspect 플래그)
// tick 성공 후:
if (opts.inspect) {
  console.log('[dev:inspect] 앱 프로세스에서 createInstrumentedEngine 로 감싸면');
  console.log('[dev:inspect] report() 를 콘솔/원격으로 노출할 수 있습니다: @rustra/devtools');
}
```

**Step 2: help 텍스트 갱신 + typecheck + Commit**

```bash
git add packages/cli/src/dev.ts packages/cli/src/index.ts
git commit -m "feat(cli): rustra dev --inspect — devtools 연결 안내"
```

---

## 백그라운드 트랙 B1 — Windows CI 실험

### 배경 지식

- 유일 하드 블로커: `lynx_desktop_win.cpp`의 FML 심볼 해석. `dumpbin /exports lynx.dll`로 export 존재 확인 후 `kFml*ExportName`(GetProcAddress 정식 경로) 또는 `kFml*Offset`(PE 오프셋 fallback) 기입.
- Lynx Windows SDK: `gh release download 4.0.1 --repo lynx-family/lynx --pattern lynx_sdk_windows_x64.zip`
- 검증 스크립트 `runner/template/desktop/verify-windows.ps1`은 6패턴 게이트. CI에서는 **심볼 덤프가 1차 목표**, 전체 게이트는 2차(실패해도 워크플로는 녹색 유지 — 실험 성격).

### Task 9: windows-experiment.yml — SDK 다운로드 + 심볼 덤프 + 빌드 시도

**Files:**

- Create: `.github/workflows/windows-experiment.yml`

**Step 1: 워크플로 작성**

```yaml
name: Windows Experiment

# P1 FML PE 심볼 해석 실험 (배경 트랙 B1). 실패해도 실험 데이터 수집이 목적 —
# 심볼 덤프 단계는 always 업로드. 수동 트리거 + main push (desktop 관련 경로만).

on:
  workflow_dispatch:
  push:
    branches: [main]
    paths:
      - 'runner/template/desktop/**'
      - '.github/workflows/windows-experiment.yml'

jobs:
  windows:
    runs-on: windows-latest
    timeout-minutes: 30
    continue-on-error: true # 실험 잡 — 메인 CI 를 막지 않는다
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.95.0
        with:
          targets: x86_64-pc-windows-msvc

      - name: Install Lynx Windows SDK
        shell: pwsh
        run: |
          gh release download 4.0.1 --repo lynx-family/lynx --pattern lynx_sdk_windows_x64.zip --dir sdk
          Expand-Archive sdk/lynx_sdk_windows_x64.zip -DestinationPath sdk/lynx
        env:
          GH_TOKEN: ${{ github.token }}

      - name: Dump lynx.dll exports (FML 심볼 해석의 근거 데이터)
        shell: pwsh
        run: |
          $dll = Get-ChildItem sdk/lynx -Recurse -Filter lynx.dll | Select-Object -First 1
          & "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe" -latest -find VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe | ForEach-Object {
            & $_ /exports $dll.FullName | Out-File -Encoding utf8 lynx-exports.txt
          }
          Select-String -Path lynx-exports.txt -Pattern "Fml|Lynx" | Select-Object -First 40

      - name: Build backend staticlib (MSVC)
        run: cargo build --release --manifest-path runner/template/backend/Cargo.toml --target x86_64-pc-windows-msvc

      - name: Build desktop host (lynx_desktop_win.cpp 링크 시도)
        run: cargo build --release --manifest-path runner/template/desktop/src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
        env:
          LYNX_SDK: ${{ github.workspace }}\sdk\lynx

      - name: Upload artifacts (심볼 덤프/빌드 로그)
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: windows-experiment-${{ github.run_id }}
          path: |
            lynx-exports.txt
          if-no-files-found: ignore
```

**Step 2: actionlint/문법 확인**

Run: `npx --yes actionlint .github/workflows/windows-experiment.yml` (또는 YAML 파스만 `node -e "require('js-yaml')..."`)
Expected: 오류 없음

**Step 3: Commit + push 후 Actions 탭에서 러너 로그 확인 (실패 시 lynx-exports.txt 아티팩트가 수확)**

```bash
git add .github/workflows/windows-experiment.yml
git commit -m "ci: windows-experiment — lynx.dll export 덤프 + MSVC 빌드 시도 (P1)"
```

---

## 백그라운드 트랙 B2 — FFI 퍼징

### 배경 지식

- 타깃: `Package::invoke_rkyv_v2(&[u8])` (`crates/rustra/src/lib.rs:462`) — 첫 2바이트 command_id(LE), 이후 postcard 인코딩 입력. FFI 진입점 `rustra_ffi_invoke_*`은 같은 디스패치를 공유하므로 `invoke_rkyv_v2`를 직접 타깃하면 핵심 디코드 경로 전체를 덮는다.
- cargo-fuzz는 **별도 crate** (`fuzz/` 디렉토리, workspace 비멤버)가 필요하다. libFuzzer sanitizer 빌드는 nightly 필요.

### Task 10: fuzz crate + CI 워크플로

**Files:**

- Create: `fuzz/Cargo.toml`, `fuzz/fuzz_targets/invoke_rkyv_v2.rs`, `.gitignore` 항목 (`fuzz/corpus`, `fuzz/artifacts`, `fuzz/target`, `fuzz/Cargo.lock`은 커밋)
- Create: `.github/workflows/fuzz.yml`

**Step 1: fuzz crate 작성**

`fuzz/Cargo.toml`:

```toml
[package]
name = "rustra-fuzz"
version = "0.0.0"
publish = false
edition = "2021"

[package.metadata]
cargo-fuzz = true

[dependencies]
libfuzzer-sys = "0.4"
rustra = { path = "../crates/rustra" }

[[bin]]
name = "invoke_rkyv_v2"
path = "fuzz_targets/invoke_rkyv_v2.rs"
test = false
doc = false
bench = false
```

`fuzz/fuzz_targets/invoke_rkyv_v2.rs`:

```rust
#![no_main]
//! invoke_rkyv_v2 퍼징 — 2바이트 command_id + postcard 본문의 무작위 바이트에 대해
//! 패닉/UB/무한루프 없이 Err 로 거부되는지 검증한다. 페이로드 길이 상한(1KiB)으로
//! 디코더 경로를 집중 공격한다.

use libfuzzer_sys::fuzz_target;

fn fuzz_package() -> rustra::Package {
    // calculator 예제 패턴과 동일한 최소 패키지 — 스키마가 아닌 디스패치/디코드 자체가 타깃.
    rustra::build!("fuzz.pkg", fuzz_add).done()
}

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
struct AddInput {
    a: i64,
    b: i64,
}

#[rustra::command]
fn fuzz_add(input: AddInput) -> rustra::Result<i64> {
    input.a.checked_add(input.b).ok_or_else(|| rustra::RustraError::custom("math.overflow", "i64 overflow"))
}

fuzz_target!(|data: &[u8]| {
    let pkg = fuzz_package();
    // Err 인코딩/정상 응답 모두 "패닉 없이 반환" 이 성공 조건.
    let _ = pkg.invoke_rkyv_v2(data);
    // 초과 길이는 상한 컷으로 디코더 집중.
    let clipped = &data[..data.len().min(1024)];
    let _ = pkg.invoke_rkyv_v2(clipped);
});
```

주의: `rustra::build!`/`#[command]`가 요구하는 임포트는 `examples/calculator/src/main.rs`의 실제 사용 패턴을 참조해 맞출 것. `checked_add`를 쓰는 이유는 퍼징 중 산술 오버플로 패닉(debug)이 실제 버그로 오인되지 않게 하려는 의도 표시이며, 실제 코드는 calculator 예제의 기존 의미를 따른다.

**Step 2: 로컬 스모크 (nightly + cargo-fuzz 설치 필요)**

Run: `cargo install cargo-fuzz --locked && cd fuzz && cargo +nightly fuzz run invoke_rkyv_v2 -- -runs=1000 -max_len=1024`
Expected: 1000 runs 완료, crash 없음. (nightly 미설치 시 `rustup toolchain install nightly` 먼저)

**Step 3: CI 워크플로 — `.github/workflows/fuzz.yml`**

```yaml
name: Fuzz

# rkyv V2 디코드 경로(신뢰 경계) 무작위 입력 검증 — 10분 타임박스.
# 크래시 아티팩트는 업로드 후 이슈 수동 등록.

on:
  workflow_dispatch:
  schedule:
    - cron: '23 19 * * 6' # 토요일 KST 새벽 — 오프피크

jobs:
  fuzz:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    continue-on-error: true # 실험 — 크래시 발견도 수확
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@nightly
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: fuzz
      - run: cargo install cargo-fuzz --locked
      - name: Fuzz invoke_rkyv_v2 (10min)
        run: cd fuzz && cargo fuzz run invoke_rkyv_v2 -- -max_total_time=600 -max_len=1024
      - name: Upload crash artifacts
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: fuzz-crash-${{ github.run_id }}
          path: fuzz/artifacts/
          if-no-files-found: ignore
```

**Step 4: Commit**

```bash
git add fuzz .github/workflows/fuzz.yml .gitignore
git commit -m "ci: cargo-fuzz invoke_rkyv_v2 — rkyv 디코드 경로 무작위 입력 검증 (10min 타임박스)"
```

---

## 마무리

### Task 11: 문서 + CHANGELOG + 회귀

**Step 1: 문서 갱신**

- `README.md`: 프로젝트 구조 `packages/`에 `testing/`, `devtools/` 추가; 개발 절에 `rustra dev` 언급
- `docs/plans/2026-08-16-post-v1-growth-design.md`: 헤더 상태 "구현 완료" 갱신
- `CHANGELOG.md` Unreleased에 신규 항목 추가

**Step 2: 전체 회귀**

Run: `cargo test --workspace && cargo clippy --all-targets -- -D warnings && cargo fmt --all -- --check && npm run build && npm run test:packages && npm run test:ts:node && npm run test -w @rustra/cli`
Expected: 전부 green

**Step 3: Commit + push**

```bash
git add -A && git commit -m "docs: post-0.1.1 성장 트랙 1차 완료 — dev/testing/devtools/실험 CI"
```

---

## 실행 순서 권장

메인 트랙(Task 1→8)은 순차 실행. Task 9/10(백그라운드)은 Task 3 완료 후 어디서든 끼워 넣기 가능 — CI 키후 삼아두는 성격이라 먼저 push 해두면 메인 트랙 진행 중 데이터가 쌓인다.

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// lint 스크립트의 파일 범위(package.json) — type-aware parserOptions 도 같은 범위에
//만 걸어야 프로그램 밖 파일 에러가 나지 않는다.
const lintedFiles = [
  'packages/*/src/**/*.ts',
  'packages/cli/src/**/*.ts',
  'scripts/**/*.ts',
  'examples/calculator/**/*.ts',
  'examples/crud/**/*.ts',
  'examples/auth/**/*.ts',
  'examples/streaming/**/*.ts',
  'examples/tauri-calculator/**/*.ts',
  'examples/reference-app/**/*.ts',
  'examples/react-native-bare-calculator/**/*.ts',
  'examples/rn-wasm-spike/**/*.ts',
];

export default tseslint.config(
  eslint.configs.recommended,
  // T5: 타입 인지 권장 세트 — no-floating-promises 등 경계 규칙이 켜진다.
  ...tseslint.configs.recommendedTypeChecked,
  {
    ignores: [
      '**/dist/**',
      '**/dist-ts/**',
      '**/node_modules/**',
      '**/*.d.ts',
      // 코드젠 산출물 — 생성기가 정본이므로 린트 대상이 아니다
      // (test:codegen-fresh 가 드리프트를 게이트한다).
      '**/generated/**',
      // 자체 툴체인/게이트를 가진 예제 — 루트 lint 범위 밖. RN 예제는 자체
      // typecheck(test:app:react-native)와 CI 잡(rn-android/rn-ios)이 검증하고,
      // napi 예제는 napi CI 잡이 검증한다.
      'examples/react-native-calculator/**',
      'examples/calculator-napi/**',
    ],
  },
  {
    // type-aware 린트의 타입 해석: 파일마다 자기 패키지의 tsconfig(컴파일 게이트와
    // 동일 관)를 먼저 쓰고, 어느 프로젝트에도 안 들어가는 파일(scripts/**, 예제 앱,
    // calculator 의 bun ffi 앱 등 tsconfig 제외 파일)만 tsconfig.eslint.json
    // 폴백으로 타인는다. 예제 tsconfig(calculator·crud 등)는 include 에
    // ../../packages/**/*.ts 로 패키지 소스 전체를 끌어들이기 때문에 배열에 넣으면
    // 패키지 파일의 프로젝트 선정을 가로채고, 플래그 없는 예제 관으로
    // no-unnecessary-type-assertion 이 게이트에 필요한 단언을 지워버린다 — 배열에서
    // 일부러 뺀다. 컴파일 게이트와 린트의 타입 관이 어긋나면 그 규칙이 게이트에
    // 필요한 단언을 지울 수 있으므로 이 순서가 계약이다.
    files: lintedFiles,
    languageOptions: {
      parserOptions: {
        project: [
          './packages/*/tsconfig.json',
          './packages/*/tsconfig.test.json',
          './tsconfig.eslint.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['packages/*/src/**/*.ts', 'packages/cli/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // lint 범위를 scripts/ 와 examples/ 로 확대. 신규 편입 영역의 기존 위반
    // (미사용 import·mock 콜백 인자, 데모 코드의 cause 체이닝 누락)은 이번
    // 변경 범위 밖 파일이라 즉시 수정할 수 없어 warn 수준으로 편입한다 —
    // 새 위반은 여전히 error 로 잡히며, warn 이 정리되면 error 로 올린다.
    // 언더스코어 접두 무시 규약은 packages/*/src 와 동일하게 적용한다.
    files: ['scripts/**/*.ts', 'examples/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
  {
    // 스크립트 유닛 테스트의 정규식 픽스처는 연속 공백 자체가 의도된 테스트
    // 데이터다(no-regex-spaces 위반이 아님).
    files: ['scripts/**/*.test.ts'],
    rules: {
      'no-regex-spaces': 'off',
    },
  },
  {
    // 테스트 러너 등록 함수(node:test/bun:test 의 test·describe·it)는 러너가
    // 프라미스를 소유한다 — 등록 호출 자체는 floating 이 아니다. 룰은 그대로
    // 켜 둔다: 테스트 본문 안의 진짜 floating promise(engine.invoke() 등)는
    // 여전히 잡힌다.
    files: lintedFiles,
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafePromises: [
            { from: 'package', package: '@types/node', name: ['test', 'describe', 'it', 'suite'] },
            { from: 'package', package: 'bun-types', name: ['test', 'describe', 'it', 'suite'] },
            { from: 'package', package: '@types/bun', name: ['test', 'describe', 'it', 'suite'] },
            { from: 'file', name: ['test', 'describe', 'it', 'suite'] },
          ],
        },
      ],
    },
  },
  {
    // 테스트 콜백은 await 가 없어도 async 로 통일한다(러너가 sync/async 콜백을
    // 동일하게 처리하고, 본문 스타일 일관성이 우선). require-await 의 안전 가치는
    // 프로덕션 코드에 있다 — src/scripts/examples 는 그대로 검사한다.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // scriptc Native FFI 앱 — scriptc build 프로그램은 진입 파일의 트리플슬래시
    // 참조로만 ffi 선언(.d.ts)의 전역 함수를 얻는다(--external-types 는 coverage
    // 전용이라 빌드 type-check 에는 안 보인다). tsconfig include 로는 scriptc
    // 체커가 못 보므로 참조가 계약이다.
    files: ['examples/calculator/apps/scriptc-app.ts'],
    rules: {
      '@typescript-eslint/triple-slash-reference': 'off',
    },
  },
  {
    // 타입 레벨 픽스처(*.test-d.ts, T9 정적 경계 테스트)는 expectType 계열의
    // "식으로만 존재하는" 단정이 본체다 — 런타임 표현식 규칙(no-unused-expressions,
    // unbound-method)은 적용 대상이 아니다. tsc -p 가 컴파일 자체를 테스트한다.
    files: ['**/*.test-d.ts'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // RN 예제 앱 두 곳(bare-calculator, rn-wasm-spike)은 의존성(react-native 등)이
    // 각 예제의 node_modules 에만 있다 — 루트 lint 잡은 그 의존성을 설치하지 않으므로
    // 모듈 타입이 영구 미해결이고 no-unsafe-* 가 환경적 오탐을 내놓는다. 이 예제들의
    // 타입 정합은 자체 typecheck 게이트(CI rn 잡·test:app:react-native)가 검증한다.
    files: ['examples/react-native-bare-calculator/**/*.ts', 'examples/rn-wasm-spike/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    // T5 예외 — packages/cli/src 는 코드젠 렌더러 태스크(T2/T9) 소유라 이번
    // 범위에서 고칠 수 없다(실측 위반: floating 502·불요단언 114·unsafe 145·
    // require-await 32 등 총 811건). 기본 recommended(타입 미사용) 규칙은 유지하고
    // type-checked 규칙만 로컬 비활성한다. cli 위반이 정리되면 이 블록을 지워
    // 전면 활성화한다.
    files: ['packages/cli/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-implied-eval': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // T5 예외 — packages/react-native/src/react-native-core.ts 는 RN 생명주기
    // 오류 구조화 태스크(T3) 소유라 이번 범위에서 고칠 수 없다(실측 위반 4건:
    // prefer-promise-reject-errors x3 · no-unsafe-return x1). 이 파일만 규칙을
    // 로컬 비활성하고, T3 가 거절 사유 정규화를 손보면 이 블록을 지운다.
    files: ['packages/react-native/src/react-native-core.ts'],
    rules: {
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
);

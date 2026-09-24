import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
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
);

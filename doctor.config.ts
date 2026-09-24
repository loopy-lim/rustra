/**
 * react-doctor CLI 설정 — 이 파일을 읽는 유일한 소비자는 CI ts-checks 잡의
 * "React Doctor (100/100, warnings block)" 스텝이다
 * (.github/workflows/ci.yml: `bunx --bun react-doctor . --blocking warning`).
 *
 * "doctor" 이름 충돌 안내 — 이 저장소에는 doctor가 3곳에 있고 서로 무관하다:
 *   1. 이 파일(doctor.config.ts) → 외부 react-doctor CLI의 lint 설정.
 *      파일명은 도구 계약이다(react-doctor는 루트의 doctor.config.{ts,js,json}만
 *      자동 발견한다). JSON 버전에서 TS로 옮긴 이유는 이 용도 주석을 파일 최상단에
 *      남기기 위해서다(JSON은 주석을 못 쓴다).
 *   2. `rustra doctor` — rustra CLI의 개발환경 진단 명령. `rustra init`이
 *      스캐폴드하는 `bun run doctor` 스크립트가 이 명령을 호출한다.
 *      이 파일과 무관하다(docs/development-hurdles.md 참고).
 *   3. `examples/react-native-calculator`의 `bun run doctor` — 그 예제 로컬의
 *      `scripts/doctor.mjs` 진단 스크립트. 이 파일과 무관하다.
 *
 * ignore.overrides — 생성물·의도된 패턴에 대한 react-doctor 규칙 예외.
 */
const config = {
  ignore: {
    overrides: [
      {
        files: [
          'examples/auth/generated/contract.ts',
          'examples/auth/generated/frame-codecs.ts',
          'examples/auth/generated/frame-registry.ts',
          'examples/streaming/generated/contract.ts',
          'examples/streaming/generated/frame-codecs.ts',
          'examples/streaming/generated/frame-registry.ts',
          'examples/react-native-calculator/modules/nitro-bench/nitro-bench/src/index.ts',
          'examples/react-native-calculator/modules/nitro-bench/nitro-bench/src/specs/NitroBench.nitro.ts',
          'examples/react-native-bare-calculator/modules/rustra-bridge/src/index.ts',
          'examples/react-native-calculator/modules/rustra-calculator/src/index.ts',
          'examples/react-native-calculator/modules/rustra-jsi/src/index.ts',
        ],
        rules: ['deslop/unused-file'],
      },
      {
        files: [
          'examples/react-native-bare-calculator/generated/commands.ts',
          'examples/react-native-bare-calculator/generated/react-native.ts',
          'examples/react-native-bare-calculator/generated/frame-codecs.ts',
          'examples/react-native-calculator/generated/commands.ts',
          'examples/react-native-calculator/generated/react-native.ts',
          'examples/react-native-calculator/generated/frame-codecs.ts',
        ],
        rules: ['deslop/unused-export'],
      },
      {
        files: [
          'generated/positional-facade.ts',
          'examples/react-native-bare-calculator/generated/positional-facade.ts',
          'examples/react-native-calculator/generated/positional-facade.ts',
          'examples/react-native-bare-calculator/generated/errors.ts',
          'examples/react-native-calculator/generated/errors.ts',
          'examples/react-native-bare-calculator/generated/devices.ts',
          'examples/react-native-calculator/generated/devices.ts',
        ],
        rules: ['deslop/unused-file'],
      },
      {
        files: [
          'examples/calculator/apps/performance-stats.ts',
          'examples/tauri-calculator/src/benchmark.ts',
          'packages/types/src/global-batch-settled.ts',
        ],
        rules: ['react-doctor/async-await-in-loop'],
      },
      {
        files: ['examples/tauri-calculator/benchmark.mjs'],
        rules: ['react-doctor/local-rpc-native-bridge-risk'],
      },
      {
        files: [
          'packages/cli/src/cargo-metadata.ts',
          'dist-ts/packages/cli/src/cargo-metadata.js',
          'packages/cli/dist-test/cargo-metadata.js',
        ],
        rules: ['react-doctor/import-metadata-execution-risk'],
      },
    ],
  },
};

export default config;

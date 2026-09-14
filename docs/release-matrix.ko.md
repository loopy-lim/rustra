# 릴리스 레지스트리 매트릭스

이 매트릭스는 읽기 전용 레지스트리 감사 도구로 생성한다. 각 workspace 버전을 독립적으로 기록하며 패키지 버전을 강제로 통일하지 않는다.

```bash
fnm exec --using=22 node scripts/audit-release-registry.mjs \
  --output /tmp/rustra-m0/registry-audit.json \
  --artifact packages/react-native/native/cpp/RustraJSIBridge.cpp \
  --artifact packages/react-native/native/android/rustra-jsi-jni.cpp \
  --artifact packages/react-native/native/ios/RustraJSIModule.mm \
  --artifact examples/react-native-bare-calculator/generated/.rustra-generated.json
```

`--output receipt.json`은 완전한 JSON 영수증과 같은 이름의 `receipt.md`를 쓴다. `--artifact PATH`는 반복할 수 있다. 이 명령은 발행·설치하지 않으며 archive를 디스크에 풀지 않는다.

## 증거 계약

npm은 package document에서 workspace의 정확한 버전, `latest` dist-tag, `gitHead`, 전체 `dist` 객체를 기록한다. document 구조를 검증하고, 정확한 버전 키가 없는 경우와 키 값이 잘못된 경우를 구분하며, 정확한 항목의 패키지 이름·버전과 HTTPS tarball 및 유효한 SHA-1 `shasum` 또는 SRI `integrity`를 확인한다. 패키지 404 또는 정상 형식의 document에 정확한 버전이 없는 경우는 `unpublished`다. timeout·네트워크 실패·잘못된 registry 응답은 `query-error`이며 명령은 0이 아닌 코드로 종료한다.

crates.io는 sparse index의 각 항목에 완전한 SemVer 문법을 적용하고 정확한 workspace 버전과 yanked되지 않은 최신 버전을 찾으며, 정확한 버전의 yanked 여부도 기록한다. 여기서 최신은 모든 yanked되지 않은 항목을 SemVer 우선순위로 비교하므로 유효한 prerelease도 포함할 수 있으며 index와 별개의 stable-only 정책을 만들지 않는다. 정확한 `.crate`를 내려받아 index checksum과 SHA-256을 대조한다. checksum이 확인된 뒤에만 제한을 검사하는 메모리 tar reader로 정확한 `<crate>-<version>/.cargo_vcs_info.json` 경로를 읽는다. timeout·조회·잘리거나 잘못된 archive·VCS 파일 누락·parse·checksum 실패는 명령을 실패시킨다.

출처 관계는 다음 세 값만 사용한다.

| 관계        | 의미                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------- |
| `exact`     | 40자리 16진수 registry revision이 후보 `HEAD`와 같고 crate VCS metadata가 clean이다.         |
| `different` | revision이 존재하지만 후보와 다르다. 버전이 섞였거나 이전 릴리스인 정상 감사 결과일 수 있다. |
| `unknown`   | 40자리 16진수 revision이 없거나 crate VCS metadata가 dirty다. 일치로 간주하지 않는다.        |

후보 영수증에는 `HEAD`, worktree dirty 상태, UTC 조회 시각이 들어간다. 로컬 artifact hash는 지정한 generated/native 바이트만 식별한다. 레지스트리 내용, 패키지 설치, 호스트 통합, 실기기 실행, 장시간 동작을 증명하지 않는다.

## 2026-09-14 스냅샷

후보 `b1ed9aa422fb4e627131f02f67de9f50bdbfedf7`는 M0 미커밋 작업이 있어 dirty였다. npm 9개의 정확한 버전과 crate 3개의 정확한 버전은 모두 발행되어 있었고 각 패키지의 현재 `latest`와 같았다. 정확한 crate 버전 중 yanked된 항목은 없었다. 모든 레지스트리 항목의 출처 revision은 `30c73bd66159f4c777054527236573559c106c98`로 후보와 `different`였다. crate archive 3개의 checksum은 sparse index와 일치했다. 운영 오류는 없었다.

| npm 패키지             | Workspace / exact / latest     |
| ---------------------- | ------------------------------ |
| `@rustra/bun`          | `0.10.0` / `0.10.0` / `0.10.0` |
| `@rustra/cli`          | `0.10.0` / `0.10.0` / `0.10.0` |
| `@rustra/devtools`     | `0.7.0` / `0.7.0` / `0.7.0`    |
| `@rustra/node`         | `0.10.0` / `0.10.0` / `0.10.0` |
| `@rustra/react`        | `0.8.0` / `0.8.0` / `0.8.0`    |
| `@rustra/react-native` | `0.9.0` / `0.9.0` / `0.9.0`    |
| `@rustra/tauri`        | `0.9.0` / `0.9.0` / `0.9.0`    |
| `@rustra/testing`      | `0.7.0` / `0.7.0` / `0.7.0`    |
| `@rustra/types`        | `0.10.0` / `0.10.0` / `0.10.0` |

| crate           | Workspace / exact / latest     | Exact yanked | Archive checksum |
| --------------- | ------------------------------ | ------------ | ---------------- |
| `rustra`        | `0.10.0` / `0.10.0` / `0.10.0` | 아니요       | 확인됨           |
| `rustra-macros` | `0.10.0` / `0.10.0` / `0.10.0` | 아니요       | 확인됨           |
| `rustra-naming` | `0.10.0` / `0.10.0` / `0.10.0` | 아니요       | 확인됨           |

재현 실행 영수증은 `/tmp/rustra-m0/registry-audit.json`과 `/tmp/rustra-m0/registry-audit.md`에 있다. `/tmp` 영수증은 실행 artifact이며 저장소 이력은 아니다.

[저장소 JSON 영수증](verification/evidence/2026-09-14-registry-audit.json)과 [생성 표](verification/evidence/2026-09-14-registry-audit.md)를 구현과 함께 보존한다.

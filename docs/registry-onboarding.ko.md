[English](registry-onboarding.md) | 한국어

# 공개 레지스트리 도입 검증

Rustra에는 목적이 다른 두 검사가 있다.

- `bun run test:onboarding`: 발행 전 현재 체크아웃을 검증한다. 로컬 Cargo patch와 패키지 symlink를 주입한다.
- `bun run verify:consumer:registry --output /tmp/rustra-registry/receipt.json`: 정확한 npm·crates.io 공개 버전으로 새 소비자를 만든다. 발행된 CLI, 네이티브 빌드, 생성된 호출, 계약 변경, 업그레이드와 롤백을 실행한다. 실제 사용한 어댑터와 미검증 구간은 영수증에 구분한다.

같은 계약을 Node/Bun 명령줄 밖으로 확장하는 형제 여정 세 가지:

- `bun run verify:consumer:tauri --output <절대경로>/registry-tauri.json` — 레지스트리만 쓰는 Tauri 소비자(`@rustra/tauri` + crates.io `rustra`의 `tauri` feature)를 구성하고, 프론트엔드를 번들해 `generate_context!` 로 내장한 뒤 실제 macOS WebView 로 부팅한다. 관측은 WebView 안의 JS가 rustra 계약 자체에 포함된 `reportEvidence` 커맨드로 되돌려 보낸다. 첫 호출, 도메인 에러 전파, 푸시 싱크 경로의 이벤트 구독/해제, 계약 필드 변경 후 재생성·실제 WebView 재실행을 다룬다.
- `bun run verify:consumer:rn-android --output <절대경로>/registry-rn-android.json --serial <adb-serial>` — 공개 React Native 커뮤니티 템플릿(Expo 없음)으로 앱을 만들고, 발행 CLI·types·어댑터를 정확 핀 설치해 코드젠이 `rustra-bridge` 네이티브 모듈을 렌더링하게 하며, cargo-ndk 로 Rust staticlib 을, Gradle 로 디버그 APK 를 빌드해 실제 Android 기기에서 실행하고 logcat 마커로 JS 관측을 회수한다. Tauri 다리와 같은 A1/A2/A3 표면을 기기 증거 수준으로 다룬다.
- `bun run verify:consumer:diagnostics --output <절대경로>/registry-diagnostics.json` — 다섯 가지 실제 실패 입력(stale 생성물, 재빌드된 바이너리에 대한 낡은 클라이언트, 부재하는 네이티브 바이너리, 비워진 `PATH` 에서의 `doctor`, 계약 밖 payload)을 주입하고 각각이 원인·대상·다음 조치를 갖춘 채 loud-fail 하는지 요구한다(A4).

이 여정들은 기본 게이트와 같은 도구에 더해, Tauri 다리는 macOS 외 추가 도구가 없고 RN 다리는 Android SDK/NDK·cargo-ndk·연결된 기기가 필요하다. 각자 출력 디렉터리 아래 고유한 영수증과 로그를 남긴다.

두 번째 검사는 Node 22, Bun 1.4, Rust 1.88 이상, 네이티브 링커와 레지스트리 접근이 필요하다. 새 임시 소비자, 검사용 캐시와 지정한 출력 디렉터리에 결과를 남긴다. 이 체크아웃에서 명령을 실행하지만 소비자는 로컬 Rustra에 의존하면 안 된다. 빈 캐시는 npm과 Cargo 의존성을 다운로드하므로 시간이 더 필요하다.

```bash
bun run test:registry-consumer
bun run verify:consumer:registry --output /tmp/rustra-registry/receipt.json
```

이전 영수증을 보존하도록 실행마다 새 출력 디렉터리를 사용한다. 첫 실패에서 중단하고 진단을 남긴다. 설치한 패키지의 버전과 출처를 검사하며, 로컬 체크아웃·Cargo patch·Git 의존성·패키지 override·symlink 대체는 실패해야 한다. 프로세스 종료 성공 외에도 실제 반환값과 변경한 필드를 검증한다.

기본 조합은 Rust `0.10.2 → 0.11.0 → 0.10.2` 업그레이드·롤백이며 npm 은 `@rustra/cli` `0.11.3`, `types` `0.12.0`, `node`/`bun` `0.10.2` — 현재 발행 라인이고, 형제 여정은 `@rustra/tauri` `0.9.3`·`@rustra/react-native` `0.9.2` 를 추가로 핀한다(`scripts/registry-consumer/versions.json`). Rust 업그레이드·롤백 1회 검증이며 연속 두 번의 제품 업그레이드를 뜻하지 않는다. 가변 `latest`가 검사 대상을 바꾸지 못하도록 버전을 고정했다. 다음 릴리스를 준비할 때 검증 버전도 검토한다.

발행 CLI는 자체 manifest에 캐럿 범위(`types ^0.12.0`, `node/bun ^0.10.0`, `tauri ^0.9.0`)를 선언한다. 최신 패치(예: `0.10.2`)가 범위 기저(`^0.10.0`)와 다른 지금, 패치에서 쓴 manifest 캐럿은 CLI 자체의 릴리스 라인 가드에 걸린다 — 그래서 게이트는 소비자 manifest에 **정확한 핀**을 쓰고, npm lock 을 `--save-exact` 로 준비하며, `npm ci` 로 설치하고 매 단계 lock 과 설치 버전을 대조한다. CLI 범위 안의 정확 핀은 CLI 가드와 오염 검사를 모두 만족한다. 더 새 해석은 여전히 실패한다. Cargo 의존성은 `=0.10.x`/`=0.11.0` 정확 핀을 유지한다. 공개 CLI를 로컬 패키지로 바꾸는 방식이 아니다.

수동 **Registry consumer** 워크플로는 macOS에서 실행하고 실패해도 영수증·로그를 업로드한다. 기존 소스 CI·발행 워크플로와 별도 증거이며 패키지를 발행하지 않는다. 로컬 성공만으로 원격 워크플로 실행 성공을 주장하지 않는다.

## 알려진 발행 CLI 결함 (2026-09-21)

형제 여정이 발행 CLI `0.11.3` 에서 발견한 도입 결함 두 가지 — 둘 다 이 저장소에서는 수정됐고 다음 CLI 발행을 기다린다:

1. 생성된 `@rustra/generated-react-native` 모듈 manifest가 `"type": "module"`을 선언했는데 `react-native.config.js`는 CommonJS다. Node 기반 오톨링킹(Gradle 설정 생성)이 이 모듈을 **조용히** 건너뛰어 `RustraBridge`가 링크되지 않았다 — Bun의 `require`가 ESM을 읽으므로 `bunx --bun react-native config` 검증으로는 보이지 않았다. 렌더러는 이제 `type`을 생략한다. 수정 CLI가 발행될 때까지 RN 여정은 코드젠 뒤 같은 수정을 적용하며 `workaround-published-cli-esm-module-manifest` 단계로 기록한다.
2. RN CLI 오톨링킹이 `node_modules` 워크스페이스 심링크 경로로 모듈을 등록하므로 Gradle `file()` 기준에서 렌더링된 어댑터 상대경로가 `node_modules/node_modules/...`로 풀렸다. 앱 소유 `react-native.config.js`에서 의존성 root 를 고정하면 회피된다(여정이 렌더링해 심는다). 렌더러 측 강화는 후보로 남긴다.

## 증거 해석

실행 도구의 revision, 패키지 버전, 실제 어댑터, OS·도구 버전, 단계별 시간, 생성물·네이티브 hash, lockfile·출처 검사, 원본 로그 위치를 함께 본다. Bun에서 Node 어댑터를 호출한 결과는 그 경로만 증명한다. Bun FFI는 실제 공유 라이브러리 호출로 확인한다.

확장 fixture는 각 어댑터의 오류 전달을 확인한다. 선언한 타입 도메인 에러는 검사하지 않는다. 이벤트 구독·해제는 위 Tauri·RN 여정이 각자의 푸시 경로에서 다룬다. fixture를 추가하기 전에 원래 Node scaffold를 실행한다.

이 검사는 기존 앱 연결, RN iOS 실행, 외부 평가자 관찰, 실기기 수명주기를 대신하지 않는다 — Tauri 실제 WebView 실행과 RN/Android 실행 다리는 형제 여정이 각각 명시한 증거 수준으로 다룬다. 2시간 부하나 4주 실사용은 어느 여정도 증명하지 않는다. [현재 로드맵 상태](verification/2026-09-16-roadmap-status.md)와 [로드맵 수용 기준](specs/2026-09-14-rustra-roadmap.md)을 따른다.

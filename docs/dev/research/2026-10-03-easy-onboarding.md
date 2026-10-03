# 첫 Rust 호출과 재실행을 쉽게 만드는 DX 개선

현재 체크아웃에서 프로젝트 생성부터 첫 호출까지 필요한 수동 명령을 줄였다.
기존 런타임 감사와 설정 오류 개선 위에 실제 시작 파이프라인을 추가한 작업이다.
새 CLI 기능은 아직 발행하지 않았으며, 아래 체험 명령은 현재 로컬 소스를 사용한다.

## 바로 실행

저장소 루트에서 Rust·Bun·저장소용 Node.js가 준비되어 있으면:

```bash
bun run try:node
# Bun FFI를 쓰려면:
bun run try:bun
```

한 명령이 잠금 파일에 맞는 저장소 의존성 설치, 패키지 빌드, 별도 예제 생성,
예제 의존성 설치, 타입 생성, Rust 빌드와 첫 `echo` 호출을 수행한다.
예제 폴더는 `target/quick-start-<host>-<unique>/app` 아래에 만들고 경로를 출력한다.
기존 프로젝트를 덮어쓰지 않는다. 체험용 저장소 설치는 lifecycle script를 실행하지
않아 Git hook 설정까지 요구하지 않는다. 실제 프로젝트의 `setup` 설치는 정상적인
패키지 매니저 설치 동작을 따른다.

출력된 폴더의 `src/lib.rs`를 바꾼 다음 그 폴더에서:

```bash
bun run start
```

타입 생성 → 의존성 설치 → Rust 재빌드 → 예제 호출을 다시 수행한다.
`try:*` 예제는 Cargo 설정에 공유 빌드 캐시와 로컬 크레이트 경로를 기록하므로
별도 `CARGO_TARGET_DIR` 환경변수가 없어도 같은 명령으로 이어서 사용할 수 있다.

## 구현

| 환경         | 자동화한 부분                                                               | 이후 필요한 부분                                       |
| ------------ | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| Node 호스트  | `init --setup`, 타입 생성, 설치, 런타임 빌드, 첫 호출                       | Rust 수정 후 `start`                                   |
| Bun FFI      | 전용 scaffold, cdylib/native entry, 같은 시작 파이프라인                    | Rust 수정 후 `start`                                   |
| React Native | 초기 어댑터 설치 순서, 생성 workspace 연결, 준비 스크립트, Rust 호스트 빌드 | 기존 RN/Expo 앱에서 플랫폼 준비와 네이티브 재빌드·실행 |
| Tauri        | 코어/팩토리 감지, 등록 헬퍼 생성, 글로벌 IPC 설정, 연결 코드 안내           | 안내된 Cargo 의존성과 등록 코드 연결, 앱 빌드·실행     |

개발 CLI에는 아래 명령을 추가했다. 발행된 CLI의 기능이라고 주장하지 않는다.

```bash
rustra init my-project --setup
rustra init my-bun-project --host bun --setup
rustra setup --run
rustra setup --skip-install
```

- `setup`은 생성, 설치, 빌드 순서를 지킨다. `--run`은 Node/Bun 프로젝트의 `demo` 스크립트를 실행한다.
- 새 RN 어댑터가 필요하면 먼저 설치한 뒤 코드 생성으로 로컬 모듈을 만들고 최종 의존성을 설치한다.
- 실패한 단계와 재시도 명령을 출력한다. 오류 수정 후 같은 `setup`을 재실행하며 `init --force`는 필요 없다.
- `packageManager`를 우선하고 없으면 lockfile을 감지한다. 다른 관리자의 lockfile을 임의로 바꾸지 않는다.
- RN workspace의 staticlib 선택을 기존 생성기와 맞추고, Cargo metadata를 조회한 디렉터리에서 해당 코어를 빌드한다.
- 모바일 C++/CMake·SDK 준비는 명시적 플랫폼 명령으로 넘긴다. 호스트 준비를 SDK 전체 설치로 막지 않는다.
- Node/Bun 런타임 경로는 macOS `/var`·`/private/var` alias에서도 올바르게 계산한다. workspace 의존성 경로 정책은 보존한다.
- 새 Cargo scaffold에 독립 workspace 경계를 넣어 기존 Cargo workspace 내부에서도 바로 시작한다.
- Tauri helper는 사용자 Rust 진입점과 Cargo manifest를 보존한다. 수정된 생성 adapter는 덮어쓰지 않는다.

RN의 실제 Expo·bare 예제에는 `rustra:ios` / `rustra:android`를 연결했다.
준비 스크립트는 필요한 Expo prebuild, iOS Pods 또는 Android debug build를 처리한다.
기존 사용자 스크립트가 있으면 보존하고 직접 실행할 대체 명령을 안내한다.

Tauri는 `rustra_setup.rs`에 기본 등록과 앱 명령 합성을 제공한다.
실제 생성된 등록 코드로 `echo`·계약 해시·기존 앱 명령·상태·플러그인·이벤트 보존을 검증했다.

## 검증

- 전체 CLI: Node 473개 + Bun 45개, 합계 518개 통과.
- 실제 `init --setup` 한 명령으로 첫 Rust `echo` 성공. 현재 후보 설치를 주입하는 fixture이며 레지스트리 발행 검증은 아니다.
- `try:node`, `try:bun`: 현재 패키지 설치부터 첫 호출 및 `start` 재실행까지 성공.
- Bun 예제의 Rust 입출력에 `repeat` 필드를 추가한 뒤 `start`로 생성·재빌드·호출 성공. 별도 Cargo 환경변수 없이도 재실행 성공.
- 실제 npm `install` → `start` 성공. npm이 파이프라인을 실행하며 scaffold의 TypeScript demo는 Bun으로 실행한다.
- 실제 Expo/bare RN 예제의 `setup --skip-install` 성공. 플랫폼 준비 명령은 실행하지 않았다.
- RN 준비 스크립트·설치 경계: controlled external-tool fixture 14개, Node/Bun에서 통과.
- Tauri 연결 JS 테스트 10개와 실제 MockRuntime IPC 테스트 2개 통과.
- 기존 온보딩 21개 테스트와 생성 → 호출 → 타입 변경 → 재생성 → 재빌드 → 호출 전체 주기 통과.
- 7개 예제 코드 생성 신선도, 문서 37개 검사, API snapshot, 테스트 목록, architecture, lint/format 검사 통과.
- 전체 lint의 기존 경고 7개는 남아 있다. 새 코드의 scoped lint는 경고/오류 없이 통과했다.

API snapshot은 Bun host 선택, additive InitHosts 필드, RN 어댑터 검색 함수 선언 변경을 반영했다.
CLI minor changeset을 추가했다.

## 증거 범위

로컬 소스와 실제 Rust 호출, 패키지 매니저 동작을 검증했다. pnpm/yarn의 실제 설치는
이번 검증에 포함하지 않았으며, manager 선택/명령 구성만 다룬다. 새 CLI를 발행하지
않았다. 새 RN/Tauri 준비 경로의 실제 모바일 앱·기기 검증이나 성능 측정은 수행하지
않았다. 이전 성능 영수증을 이번 온보딩 변경의 실행 증거로 재사용하지 않는다.

상세 명령, 로그 SHA, 소스 SHA와 직접 실행 기록은
[검증 영수증](../../benchmark-receipts/2026-10-03-easy-onboarding-validation.json)에 남겼다.

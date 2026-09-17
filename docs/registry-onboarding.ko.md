[English](registry-onboarding.md) | 한국어

# 공개 레지스트리 도입 검증

Rustra에는 목적이 다른 두 검사가 있다.

- `bun run test:onboarding`: 발행 전 현재 체크아웃을 검증한다. 로컬 Cargo patch와 패키지 symlink를 주입한다.
- `bun run verify:consumer:registry --output /tmp/rustra-registry/receipt.json`: 정확한 npm·crates.io 공개 버전으로 새 소비자를 만든다. 발행된 CLI, 네이티브 빌드, 생성된 호출, 계약 변경, 업그레이드와 롤백을 실행한다. 실제 사용한 어댑터와 미검증 구간은 영수증에 구분한다.

두 번째 검사는 Node 22, Bun 1.4, Rust 1.88 이상, 네이티브 링커와 레지스트리 접근이 필요하다. 새 임시 소비자, 검사용 캐시와 지정한 출력 디렉터리에 결과를 남긴다. 이 체크아웃에서 명령을 실행하지만 소비자는 로컬 Rustra에 의존하면 안 된다. 빈 캐시는 npm과 Cargo 의존성을 다운로드하므로 시간이 더 필요하다.

```bash
bun run test:registry-consumer
bun run verify:consumer:registry --output /tmp/rustra-registry/receipt.json
```

이전 영수증을 보존하도록 실행마다 새 출력 디렉터리를 사용한다. 첫 실패에서 중단하고 진단을 남긴다. 설치한 패키지의 버전과 출처를 검사하며, 로컬 체크아웃·Cargo patch·Git 의존성·패키지 override·symlink 대체는 실패해야 한다. 프로세스 종료 성공 외에도 실제 반환값과 변경한 필드를 검증한다.

기본 조합은 Rust `0.10.0 → 0.10.1 → 0.10.0`, npm `@rustra/cli`, `types`, `node`, `bun`은 각각 `0.10.0`이다. Rust 패치 업그레이드·롤백 검증이며 연속 두 번의 제품 업그레이드를 뜻하지 않는다. 가변 `latest`가 검사 대상을 바꾸지 못하도록 버전을 고정했다. 다음 릴리스를 준비할 때 검증 버전도 검토한다.

수동 **Registry consumer** 워크플로는 macOS에서 실행하고 실패해도 영수증·로그를 업로드한다. 기존 소스 CI·발행 워크플로와 별도 증거이며 패키지를 발행하지 않는다. 로컬 성공만으로 원격 워크플로 실행 성공을 주장하지 않는다.

공개 CLI `0.10.0`은 소비자 manifest에서 `^0.10.0` 같은 표기를 요구한다. 따라서 gate는 npm lock을 만들 때 정확한 `package@0.10.0`을 선택하고 `npm ci`로 설치한 뒤, 매 단계 lock과 실제 설치 버전을 대조한다. manifest 범위가 허용하더라도 다른 패치 버전이 설치되면 실패한다. Cargo 의존성은 `=0.10.x`로 고정한다. 공개 CLI를 로컬 패키지로 바꾸는 방식이 아니다.

확장 fixture는 각 어댑터의 오류 전달을 확인한다. 선언한 타입 도메인 에러나 이벤트 구독·해제는 검사하지 않는다. fixture를 추가하기 전에 원래 Node scaffold를 실행한다.

## 증거 해석

실행 도구의 revision, 패키지 버전, 실제 어댑터, OS·도구 버전, 단계별 시간, 생성물·네이티브 hash, lockfile·출처 검사, 원본 로그 위치를 함께 본다. Bun에서 Node 어댑터를 호출한 결과는 그 경로만 증명한다. Bun FFI는 실제 공유 라이브러리 호출로 확인한다.

이 검사는 Tauri WebView 실행, 기존 앱 연결, RN Android·iOS 실행, 외부 평가자 관찰, 실기기 수명주기를 대신하지 않는다. 2시간 부하나 4주 실사용도 증명하지 않는다. [현재 로드맵 상태](verification/2026-09-16-roadmap-status.md)와 [로드맵 수용 기준](specs/2026-09-14-rustra-roadmap.md)을 따른다.

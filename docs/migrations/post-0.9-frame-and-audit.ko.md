[English](./post-0.9-frame-and-audit.md) | 한국어

# 0.9 이후 Frame·감사 수정 마이그레이션 (릴리스 준비)

이 문서는 **아직 발행하지 않은 동시 업그레이드 계획**이다. 2026-09-10 릴리스에서
Rust와 types/node/bun/cli는 이미 0.9.0을 사용했으므로 같은 버전을 재사용하지 않는다.
열린 릴리스 작업의 정확한 대상과 최종 커밋은 확인이 필요하다. 현재 manifest 버전은
변경하지 않았으며, [호환 표](../compatibility-matrix.ko.md)는 이 manifest를 기준으로 한다.

대기 changeset은 변경된 JS 9개 패키지의 pre-1.0 minor bump를 제안한다.
types/node/bun/cli 0.9.0 → 0.10.0, tauri/react-native 0.8.0 → 0.9.0,
react 0.7.1 → 0.8.0, testing/devtools 0.6.2 → 0.7.0이며 **아직 적용하지 않았다**.
Rust workspace의 다음 breaking minor(제안 0.10.0)와 CLI의
`rustraTemplate.cargoRange`도 공유 types 라인에 맞춰 함께 조정한다. 버전 workflow에서
npm 내부 의존 범위, CLI RN 템플릿 범위, lockfile과 생성 manifest를 갱신한다.
독립 어댑터는 각각의 버전 번호를 유지한다.

## 네이티브 라이브러리·JS·생성물을 함께 교체

Frame 전환은 공개 API와 네이티브 심볼 이름을 변경한다. 이름 전환 자체는 wire 바이트를
바꾸지 않지만 이전 JS와 생성 네이티브 셸은 여전히 이전 심볼을 조회한다. wire fixture
통과만으로 서로 다른 패키지 버전의 조합이 동작한다고 판단할 수 없다.

| 기존 표면                                                                                 | 새 표면                                                                              |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `createRkyvV2Engine`, `RkyvV2Engine`, `RkyvV2Codec`, `RkyvV2Native`, `RkyvV2SchemaNative` | `createFrameEngine`, `FrameEngine`, `FrameCodec`, `FrameNative`, `FrameSchemaNative` |
| `invokeRkyvV2`                                                                            | `invokeFrame`                                                                        |
| `rustra_ffi_invoke_rkyv_v2{,_into,_async,_async_into}`                                    | `rustra_ffi_invoke_frame{,_into,_async,_async_into}`                                 |
| `rkyv-codecs.ts`, `rkyv-registry.ts`                                                      | `frame-codecs.ts`, `frame-registry.ts`                                               |
| `BUN_RKYV_V2_ENGINE_SUPPORTS`, `REACT_NATIVE_RKYV_V2_ENGINE_SUPPORTS`                     | `BUN_FRAME_ENGINE_SUPPORTS`, `REACT_NATIVE_FRAME_ENGINE_SUPPORTS`                    |
| debug transport `'rkyv'`                                                                  | `'frame'`                                                                            |

사용되지 않던 `RustraNative.invokeRkyv` 타입 멤버도 제거한다. 수동 import, custom FFI,
네이티브 mock, 진단 필터를 갱신한다. 새 CLI의 `rustra codegen --config rustra.json`을
실행하고 네이티브 셸·라이브러리·앱을 다시 빌드한다. 생성 파일과 manifest를 함께 커밋하고,
롤백을 위해 이전 릴리스의 lockfile과 네이티브 산출물을 보관한다.

## Tauri 채널

JS 채널은 발급한 물리 WebView의 IPC Channel을 사용하고 `ipc-channel-chunks-v1`을
협상한다. `@rustra/tauri`와 Rust를 함께 다시 빌드한다. 이전 이벤트 브로드캐스트 호스트는
거부한다. 전역 감지에는 `core.Channel`과 콜백 정리 API가 필요하며, 직접 설정한다면
`createIpcChannel(onMessage) => { value, dispose() }`를 제공한다. `listen`만으로는
부족하다. 원시 조각, 네이티브 min(런타임 한도, 16 MiB) 제한(코어 기본 설정은 1 MiB),
JS 재조립 상한 16 MiB, 30초 재조립 제한과 종료 정책은
[채널 가이드](../events-and-channels.ko.md#5-채널--js-쪽)를 따른다. 일반 이벤트와
신뢰된 Rust 호스트 헬퍼는 브로드캐스트를 유지한다. 네이티브 GUI 종료 검증은 별도다.

## React와 개발 도구

SSR 요청·계정별로 Provider 엔진을 분리한다. Suspense 캐시는 엔진당 256개,
완료 후 5분 TTL, 대기 30초 제한을 적용한다. 대기 제한은 실제 엔진 작업을 취소하지
않는다. `configureSuspenseCache`로 조정하고, 한 엔진만 무효화하려면
`invalidateCommands`에 엔진을 전달한다. 미지원 입력은 키 충돌 대신 오류로 거부한다.
Mutation 완료 콜백은 표시 상태 초기화 후에도 해당 호출에 귀속된다.
[React 가이드](../../packages/react/README.ko.md)를 참고한다.

`uniffi.output`은 `uniffi/` 또는 `src/bindings/` 같은 바인딩 전용 디렉터리로 둔다.
schema·TS 출력과 겹치거나 Rust 소스 루트·Cargo manifest를 덮을 수 없다. 성공한
생성은 디렉터리 전체를 교체한다. 일반 `codegen --check`는 Rust mirror를 검사하며,
`codegen --check-bindings`가 빈 디렉터리에서 실제 Swift/Kotlin/헤더/modulemap을
생성하고 비교한다.

Hot-core는 심볼 안전성을 위해 라이브러리를 보관한다.
`rustra::hot_core::retained_library_stats()`의 `libraries`는 누적 보관 로드 수,
`artifact_bytes`는 파일 크기의 합이며 RSS가 아니다. `restart_recommended()`는
32회부터 true이다. 개발 호스트를 재시작해야 이 라이브러리를 해제할 수 있다.

## 후보 검증과 묶음 롤백

최종 후보에서 frozen 설치, 릴리스 정합, build/lint/format/test, API 표면, 문서,
코드젠, 바인딩 신선도, packed consumer 검사를 수행한다. 저장소 프로세스 테스트는
Node 22가 필요하며 발행 CLI의 최소 런타임은 Node 18을 유지한다. 변경된 JS 패키지를
모두 pack하고 깨끗한 소비자는 로컬 Rust crate 경로를 사용하여 레지스트리의 이전
버전으로 조용히 대체되지 않게 한다. Node·Bun과 대상 네이티브 호스트의 새 셸을
검사하고 로컬·동일 커밋 CI·레지스트리 발행·실기기 결과를 구분해 기록한다.

문서와 changeset이 있다는 이유로 병합·발행하지 않는다. 승인된 버전 workflow로 Rust와
JS를 함께 릴리스하고 실제 레지스트리 산출물을 확인한다. 롤백은 이전 JS 의존 세트,
lockfile, 생성물, 네이티브 앱 빌드를 함께 복원한다. JS 어댑터만 되돌리면 이전 네이티브
심볼·프로토콜 호환성을 복원할 수 없다.

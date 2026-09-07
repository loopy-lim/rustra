# 플랫폼 상호운용 안정화 — 구현 계획 (2026-09-07)

설계: `2026-09-07-platform-interop-stabilization-design.md`

- [x] Task 0 — 설계 문서
- [x] Task 1 — `Platform` enum + `Platform::current()` (`platform.rs`)
- [x] Task 2 — `RustraError::platform_unavailable` + 코드 테이블 갱신 (error.rs)
- [x] Task 3 — `Command.platforms` 필드 + `build_command` 기본값 (command_types.rs, command_build.rs)
- [x] Task 4 — `platform_command` / `platform_command_impl` 빌더 + build() 정합 검증 (builder_platform.rs, builder_build.rs, builder.rs include)
- [x] Task 5 — 스키마 `"platforms"` 필드 (package_schema.rs)
- [x] Task 6 — TS `RustraErrorCode.PlatformUnavailable` (errors.ts)
- [x] Task 7 — 계산기 예제 `platformNativeInfo` (macos/windows impl, linux=스텁) + Rust 테스트
- [x] Task 8 — 예제 재생성(schema.json/TS/fingerprint) + api-surface 스냅샷
      — 도중 발견·수정: codegen unit-입력 코덱 버그(`args: ()` 그대로 방출), legacy-removal
      병합 이후 stale 계약테스트(Swift 심볼 기대치) 갱신
- [x] Task 9 — RN C++ 공개 진입점 `invokeTypedByName/ById` 추출 (RustraJSIBridge, 단일 경로 리팩터)
- [x] Task 10 — 문서: rust-api-guide(en/ko) 플랫폼 명령 절 + react-native-setup(en/ko) C++ 진입점 절
- [ ] Task 11 — changeset — **사용자 지시로 제외** (발행 게이트에서 별도 처리)

검증 기록 (2026-09-07): cargo workspace tests 전 통과, clippy 0 경고,
C++ codec tests 통과, test:ts:node 61/61, test:node-runtime 44/44,
test:packages 통과, docs-gate 6영역 통과, api-surface 게이트 통과.

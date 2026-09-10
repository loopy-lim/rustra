# UniFFI 성숙도 따라잡기 연구 (2026-09-11)

상태: complete. 조사 방법 — uniffi-rs 저장소(main, 0.32.0 이후)·공식 문서 직접 확인,
rustra-bridge 는 로컬 저장소 코드/CI/문서 직접 감사. 문서에 없는 사항은 미공개(unknown)로
명시. 선행 연구: `docs/research/2026-09-07-competitive-landscape.md`(기능 비교),
2026-09-11 uniffi 부착 스파이크(공존 실측 — 이 문서의 Track B 근거).

질문 정의: "rustra 에 uniffi 를 붙이는가"가 아니라 **"uniffi 수준의 성숙도에 도달하려면
무엇을 해야 하는가"**. 결론 — 성숙도의 실체는 언어 개수가 아니라 **계약의 기계화**
(체크섬·로드시 검증·실패주입·픽스처 규율)와 **산출물 기준 코드젠 게이트**이고,
이는 언어 커버리지 결정과 독립적으로 벤치마킹 가능하다.

## 1. uniffi 성숙도 해부 — 12 관행

1. **2단계 ABI 계약**: 전역 `UNIFFI_CONTRACT_VERSION`(u32, "프로토콜이 바뀌었나") +
   **심볼별 u16 체크섬**(컴파일타임 const FNV-1a-64→16bit, MetadataBuffer 직렬화 —
   모듈경로·이름·is_async·파라미터 이름/타입/PassBy/옵션/디폴트·반환·throws 까지 해시).
   바인딩이 라이브러리 로드 시점에 전체 검증, actionable 에러 메시지
   ("try cleaning and rebuilding"). 부분/스테일 리빌드, 바인딩↔dylib 버전 불일치를
   UB 이전에 실패로 전환. 못 잡는 것: 동일 메타데이터의 동작 변경(비교만 가능).
2. **버전 기계 자체의 실패주입**: `fixtures/version-mismatch` — 9개 셸 스크립트가
   `UNIFFI_FORCE_CONTRACT_VERSION=0` 등으로 일부러 불일치를 만들고 foreign 테스트가
   올바른 에러로 죽는지 단언. "검증 코드가 스스로 썩는 것"을 막는 픽스처.
3. **컴파일 산출물에서 바인딩 생성**: proc-macro 가 `UNIFFI_META_*` static 을 dylib 에
   심고, library-mode bindgen 이 오브젝트 파일 심볼을 스캔(Mach-O/PE/COFF/fat binary)
   해서 "실제 링크된 것"에서 생성. 소스↔아티팩트 드리프트를 정의상 제거,
   megazord(다중 컴포넌트 1 dylib) 가능.
4. **결정적 코드젠**: 안정 정렬 → 생성물 byte-deterministic(0.30 changelog 명시).
   2회 생성 비교로 테스트 가능.
5. **언어 관용구 품질의 공학화**: 템플릿 렌더러(Askama/Rinja) + 외부 바인딩 저자용
   Bindings IR pipeline(0.32, 실험), rename-aware 메타데이터+언어별 케이싱 필터,
   docstring 추출·이스케이프, Swift Sendable 대응, **생성된 Python 을 CI 에서 mypy 검사**.
6. **서면 타입시스템 안전 계약**: "외부 코드가 악의적으로 호출해도 UB 불가" 총괄 불변식,
   Send+Sync 강제, panic 불통과(catch_unwind→RustCallStatus), u64 객체 핸들(0=invalid,
   외래 핸들은 최하위 비트 태그), 와이어 포맷은 "내부용·버전 간 변경 가능"을 명시(ADR 0002).
7. **픽스처 디렉터리 = 실행형 적합성 스위트**: 약 29개 시나리오 크레이트(callbacks,
   coverall, enum-types, error-types, ext-types, futures, keywords, large-enum/error,
   regressions, version-mismatch, uitests(trybuild 컴파일실패) 등). 각 픽스처가 언어별
   병렬 테스트를 갖고 `build_foreign_language_testcases!` 매크로로 **cargo test 한 번에
   Rust+4언어** 실행. 모든 크로스언어 버그→`regressions/` 픽스처 규율.
8. **실실행 CI**: 4언어 번들 이미지로 전 매트릭스, **최소지원 Rust + 최신 Rust 2개 러스트**,
   clippy `-D warnings`, 생성 코드 mypy, wasm 클리피. 디바이스 레벨은 下流(application-services) 위임.
9. **릴리스 공학**: 백엔드 크레이트 `=0.32.0` exact pin + core 의 컴파일타임
   `check_compatible_version`(왜: 생성 코드가 런타임 내부를 만짐 — 다이아몬드 의존성 방지),
   `docs/uniffi-versioning.md` 의 "무엇이 breaking 인가" 열거, 외부 바인딩 저자 전용
   breaking 섹션, 마이너별 버전 문서(mike).
10. **프로덕션 경련 루프**: Firefox 모바일 megazord + 데스크톱 gecko-js 소비.
    breaking FFI 변경(0.30 객체 핸들 재작업)도 contract bump+changelog+픽스처로 소화.
11. **문서 3층**: user guide / internals(바인딩 생성기 저자 대상 — lifting/lowering 표,
    시퀀스 다이어그램, 심볼 셰이프) / ADR 0000–0009(거부된 선택지까지 기록).
12. **정직한 한계(=rustra 가 앞선 축)**: 공개 스키마 인트로스펙션 없음(메타데이터 사적),
    와이어 포맷 안정성 계약 없음(내부용 명시), 핫리로드 스토리 없음(로드시 검증이
    오히려 재로드 거부), 페이로드 한도·협상 없음, 취소는 async cancel 만.

## 2. rustra 현재 성숙도 인벤토리 (강제 수준 표기: CI-hard/test/script/doc-only/absent)

| 차원 | rustra 현재 | 강제 |
|---|---|---|
| ABI 계약 | api-surface snapshot(32 심볼 **이름만**), 전역 contract_hash(SHA-256 of schema JSON), schema_generation 카운터 | 이름 세트 CI-hard |
| 심볼별 체크섬 | `command_wire_signature` 존재(`package_schema.rs:243`)하나 **핫리로드 게이팅 전용** — 발행된 체크섬 표면 없음 | test |
| 런타임 검증 | `contract.mismatch` fail-fast — **opt-in**(소비자가 contractHash 직접 전달 시에만), 미설치 시 `unenforceable`, schemaVersion stale 은 warn | test(opt-in) |
| 코드젠 신선도 | committed `generated/` 재생성+diff CI 없음, doctor `codegen.generated_freshness` warn 레벨 | warn |
| 크로스언어 적합성 | 3코너 pinned hex(Rust↔TS↔C++) — **calculator 1개 픽스처만**, 예제=애드혹 | test |
| 부정경로 | trust_baseline_ffi, payload_robustness, rkyv_v2_panic/concurrency, ota_compat — 강함 | test |
| 퍼징/새니타이저 | fuzz 3타깃+시드, miri, sanitizer — **주간 non-gating**(continue-on-error) | absent(gating) |
| CI 매트릭스 | rust 3-OS+MSRV 1.88+wasm, rn-android/rn-ios **빌드만(실행 없음)**, TS ubuntu 1-OS, consumer-smoke 강함, aggregate gate | 부분 |
| 버저닝 | versioning-policy.md(표면별 보장표+폐기 주기), changesets+9패키지, check-release-coherence CI-hard, crates 수동 SHA 재검 | 상/일부 doc-only |
| 문서 | en/ko 미러 100%(수동, 자동검사 없음), docs-gate=sync 마커만, ADR absent, typedoc 수동 | 부분 |
| 역방향 | events/channels/cancellation 테스트 됨, reverse-callbacks 설계완료 미착지 | test/absent |
| 비-JS 언어 | **전무**(swift-ffi-bench 는 벤치 하네스) | absent |

가장 약한 강제 지점 Top-5(성숙 프레임워크 주장에 하중을 받치는 것들):
① FFI **서명** 변경이 api-surface 게이트를 통과(이름만 비교), ② committed 생성물
신선도 무검증, ③ 런타임 계약 검증 opt-in, ④ 모바일 런타임 E2E absent(수동 체크리스트),
⑤ 안전망 트랙 전체 non-gating + 미러/typedoc 수동.

## 3. 갭 분석 — uniffi 관행 ↔ rustra

| uniffi 관행 | rustra 상태 | 갭 크기 | 복사 비용 |
|---|---|---|---|
| 1. 심볼별 체크섬+로드시 검증 | 전역 hash+이름 스냅샷, 검증 opt-in | **큼(최우선)** | 소 — `command_wire_signature` 승격 경로 존재 |
| 2. mismatch 실패주입 픽스처 | mismatch 경로 테스트 부분 | 중 | 소 |
| 3. 산출물 기준 코드젠 | 스키마 기준이나 신선도 무게이트 | 중 | 소 — regenerate+`git diff --exit-code` |
| 4. 결정적 생성물 | preserve_order+BTreeMap, pinned hex 로 실질 보장 | 소 | 소 — 2회 생성 테스트 명문화 |
| 5. 언어별 관용구+생성코드 타입검사 | TS 강함(tsc/consumer-smoke), C++ 컴파일 테스트 | 중(TS 한정 양호) | 중 |
| 6. 서면 안전 계약 | 불변식이 문서에 산재(panic guard, 포이즌, abort 계약) | 중 | 소 — 통합 문서 1장 |
| 7. 픽스처 매트릭스+회귀 규율 | 애드혹 예제, pinned hex 1개 | **큼** | 중 |
| 8. 실실행 CI(2-러스트, 생성코드 타입검사, 디바이스) | MSRV 잡 있음, 모바일 빌드만 | 중 | 중(에뮬 E2E 인프라는 핫코어에서 실증됨) |
| 9. exact pin+버저닝 문서 | ranges+coherence 스크립트로 대체 실현 | 소 | — |
| 10. regressions 루프 | 부분(trust_baseline) | 소 | 규율화 |
| 11. internals/ADR 문서층 | internal/ 있음, ADR absent | 중 | 중 |
| 12. 언어 커버리지(Kotlin/Swift/Python) | absent | **가장 큼** | 별도 의사결정(Track B) |

## 4. rustra 가 이미 앞선 축 (복사할 필요 없음)

공개 스키마 인트로스펙션(schema.json — uniffi 는 사적 메타데이터), 와이어 포맷 안정성
계약(릴리스 스키마당 freeze + `docs/wire-format.md` — uniffi 는 내부용·불안정), 핫스왑
(dev dylib 스왑 — uniffi 전무), 페이로드 한도·취소 프레임워크(async 넘는 협력적 취소),
호스트 코덱 버저닝 패리티 게이트, en/ko 이중어 문서. → "따라잡기"는 이 강점을 유지한 채
**계약 기계화·테스트 관행**을 도입하는 일이다.

## 5. 로드맵

### Track A — 성숙도 관행 벤치마킹 (rustra 모델 유지, 언어 결정과 독립)

- **A1. 심볼별 체크섬 표면화** (최우선): `command_wire_signature` 를 발행 표면으로 승격 —
  api-surface snapshot 에 서명/체크섬 포함하거나 FFI 함수별 checksum 심볼 export.
  api-surface.mjs 를 이름→서명 비교로 확장. uniffi 관행 1 해소.
- **A2. 런타임 검증 디폴트-온**: `contract.mismatch` 를 기본 활성(escape hatch 유지),
  `contract.unenforceable` 정책 재검토. uniffi 관행 1 의 런타임 절반.
- **A3. 실패주입 픽스처**: 강제 구버전 contract_hash 로 빌드→호스트가 올바른 에러로
  죽는지 단언(uniffi `version-mismatch` 모사). A1·A2 가 썩지 않게 하는 장치.
- **A4. 코드젠 신선도 CI 게이트**: 재생성→`git diff --exit-code`, doctor warn 승격.
  uniffi 관행 3·4 해소.
- **A5. 픽스처 매트릭스**: 피처당 1 픽스처(태그드 유니온/맵/셋/에러/이벤트/채널/취소/
  비동기/대형 페이로드) + 3코너 pinned hex 전체 확산 + "모든 크로스언어 버그→픽스처" 규율.
  uniffi 관행 7 해소.
- **A6. 모바일 런타임 E2E**: rn-android/rn-ios 에뮬·시뮬 실행 잡(핫코어 E2E 에서
  이미 실증한 인프라의 CI 화). uniffi 관행 8 중 디바이스는 uniffi 도 下流 위임이라
  여기서 rustra 가 역전 가능.
- **A7. 안전 계약 문서 + ADR**: `docs/safety-contract.md`(panic 불통과, 외래 예외 abort
  계약, 버퍼 소유 규칙, 포이즌 의미론, 페이로드 한도) + FFI 계약 결정에 번호 ADR 관행.
  uniffi 관행 6·11 해소.
- **A8. 문서 게이트 확장**: ko 미러 완전성 자동검사, typedoc CI 화.
- (선택) **A9. 안전망 게이팅**: fuzz/miri/sanitizer 주간→PR 경량판 또는 실패시 알림 게이트.

### Track B — 언어 커버리지 (별도 의사결정)

- **B1. uniffi 캐리어 채택**: 2026-09-11 스파이크로 공존 실측됨(additive, 기존 표면
  무변경). uniffi 의 체크섬·계약 기계가 신규 표면을 무료로 경비해주는 시너지.
- **B2. rustra 네이티브 멀티언어 바인젠**: 메타데이터 static+산출물 스캔+언어 템플릿 =
  사실상 uniffi 재구현급 투자. rustra 가 범용 브리지 프레임워크로 uniffi 와 직접
  경쟁하는 목표일 때만 정당.
- 어느 쪽이든 Track A 의 관행이 전제 — A 없이 B2 는 성숙도 없는 복제가 된다.

## 6. "5개만 복사한다면" 우선순위

1. 심볼별 체크섬 + 로드시 검증 + 실패주입 픽스처 (관행 1+2 — 최고 레버리지)
2. 산출물 기준 코드젠 신선도 게이트 (관행 3·4)
3. 픽스처 매트릭스 + 회귀→픽스처 규율 (관행 7·10)
4. 서면 안전 계약 — 총괄 불변식 1장 (관행 6)
5. "무엇이 breaking 인가" 버저닝 문서 고도화 + 백엔드 pin 재검 (관행 9)

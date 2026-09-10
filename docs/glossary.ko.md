[English](./glossary.md)

# 용어집 (Glossary)

rustra 내부에서 여러 뜻으로 쓰이거나, 같은 이름의 외부 개념과 혼동되기 쉬운
용어의 정의 레퍼런스. 각 항목은 그 용어가 **무엇인지**, **표기 표준**, 그리고
권위 문서 위치를 선언한다. 이 문서는 이력을 추적하지 않는다 — 판단과 경로는
링크된 문서를 따른다.

표기 정책: 기술 식별자(crate 이름, cargo feature, 모듈·심볼 이름, config 키,
플래그)는 두 언어 모두 라틴 문자 그대로 쓴다. 한국어 서술에서 핫코어/핫스왑 같은
개념 어설을 식별자와 병기할 수는 있지만, 식별자 자체(`hot-core`, `parity gate`,
`contract hash`)를 음역하지 않는다.

| 용어                    | 한 줄 정의                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------- |
| rkyv vs rkyv V2         | 업스트림 crate(미사용) vs Rustra 자체 바이너리 프레임 프로토콜 이름                |
| postcard                | 실제 페이로드 코덱(serde 호환 compact 포맷)                                        |
| Tier 1 / 2 / 3          | 와이어 코덱 티어: 정적 postcard / complex 스키마 / JSON-in-binary 폴백             |
| dev tier                | "개발 중 동적 / 릴리스 정적" 개발 장치 — 와이어 티어와 무관                        |
| hot-core                | 네이티브 dylib 핫스왑 dev 메커니즘(실험)                                           |
| `rustra_ffi_hot_reload` | 구 hot-* 메커니즘: replace 의미론 리로드 주입                                      |
| parity gate             | `rustra dev`가 reload 방출 전 contract hash 를 비교하는 재빌드 게이트              |
| contract hash           | 스키마 JSON만의 SHA-256                                                            |
| dylib / cdylib          | Rust 동적 라이브러리 crate-type — 핫스왑 단위                                      |
| 채널 계열               | `ChannelHandle` + 호스트별 4종 바이너리 채널 팩토리                                |
| host                    | 4개 의미: 임베딩 앱 / `ChannelHost` / JSI host 객체 / host promotions              |
| snapshot                | 4개 의미: API 스냅샷 / 인스펙터 덤프 / 디버그 로그 값 / changeset canary           |
| gate (단독)             | 과적합 단어: 프로파일·capability·drift·릴리스·acceptance·api-surface·스크립트 이름 |
| codec / Codec IR        | 페이로드 직렬화기 / complex codec 뒤의 공유 스키마 IR                              |
| mirror                  | 3개 의미: en/ko 문서 쌍 / 수동 관리 중복 / "X를 따른다" 동사 용법                  |
| subsecond               | dioxus 핫리로드 기술 — 검토 후 보류; 아키텍처의 일부 아님                          |

## rkyv vs rkyv V2

**rkyv V2**는 Rustra 자체 바이너리 프레임 프로토콜(V2 프레이밍 + command id +
postcard 페이로드 코덱)의 이름이다. 업스트림 `rkyv` crate가 **아니다**: 그
crate는 `Cargo.lock`에 없고, 페이로드 코덱은 postcard다. 표준 와이어 형태 —
요청 `[cmd_id u16 LE][postcard body]`, 응답 `[ok u8][pad][...]`(본문은 경로별
상이), 에러 프레임 `[ok=0][pad][err_len u16 LE][postcard {code, message}]`.
와이어 레벨의 권위는 [wire-format.md](wire-format.md)의 "Names" 표다. 생성
산출물·심볼은 rkyv 이름을 유지한다(`rkyv-codecs.ts`, `invokeRkyvV2`) — 이는
crate 의존이 아니라 프로토콜 이름이다.

## postcard

manifest/dispatch 경로에서 실제로 쓰는 페이로드 직렬화기(`crates/rustra/Cargo.toml`
의 `postcard` 의존성). serde 호환 compact 바이너리 포맷이다. 문서가 어떤 명령을
"postcard 인코딩"이라고 하면 그 rkyv V2 프레임 안의 구체 코덱이 이것이다.

## Tier 1 / Tier 2 / Tier 3 (와이어 코덱 티어)

명령 페이로드가 rkyv V2 프레임 안에서 취하는 세 가지 코덱 경로:

- **Tier 1** — 정적 postcard: 스키마로 아는 단순 필드, postcard 인코딩.
- **Tier 2** — complex 스키마: 재귀 map/enum/Option/Set/BigInt 형태를
  스키마 기반 complex codec 으로 처리.
- **Tier 3** — JSON-in-binary 폴백: `[cmd_id u16 LE][JSON]`, 어느 바이너리
  코덱도 지원하지 않는 스키마용. 구현: `crates/rustra/src/rkyv_tier3.rs`.

[architecture.md](architecture.md)("동적 명령의 호출 경로")와
[complex-codecs.md](complex-codecs.md) 참고.

## dev tier (개발 동적 / 릴리스 정적)

**동적 개발 티어** — "개발 중 동적, 릴리스 정적" 장치들(`invokeLoose`, debug
런타임 등록, 카탈로그 밖 디바이스 토큰, `test:fast`). [dev-tier.md](dev-tier.md)
문서가 권위다.

주의: 이 **티어**는 위 와이어 코덱 티어와 무관하다. "dev tier"는 계약이 열려
있거나 얼어 있는 시점에 관한 것이고, "Tier 1/2/3"는 페이로드를 와이어에 어떤
코덱으로 인코딩하는가에 관한 것이다.

## hot-core

네이티브 dylib 핫스왑 개발 메커니즘: Rust 코어를 cdylib 으로 빌드해 실행 중인
호스트에 재시작 없이 스왑한다. `hot-core` cargo feature, `DylibCore`/
`HotCoreHandle` 프리미티브, sha256 폴링 감시자, 아티팩트 경로를 호스트에 알리는
`RUSTRA_HOT_CORE` 환경변수로 구성된다(React Native 어댑터는 대신
`RUSTRA_HOT_CORE_DIR`가 지정한 디렉터리를 폴링한다 — 파일 경로와 디렉터리는
서로 다른 두 변수다). **실험**
([versioning-policy.md](versioning-policy.md) 실험 표면 표 참고). 설계와 상태:
[plans/2026-09-09-native-hot-core-design.md](plans/2026-09-09-native-hot-core-design.md).

표기 표준: 두 언어 모두 `hot-core`. 한국어 서술에서 개념 설명은 핫코어/핫스왑
병기를 허용하지만, 피처·모듈·플래그 표기는 `hot-core` / `RUSTRA_HOT_CORE` 라틴
그대로 유지한다.

## `rustra_ffi_hot_reload` vs hot-core

혼동하면 안 되는 서로 다른 두 hot-* 메커니즘:

- **`rustra_ffi_hot_reload`** — 구 메커니즘: replace 의미론의 리로드 **주입**
  (호스트가 호출해 프로세스 내 엔진 상태를 리셋하는 FFI 엔트리).
  [versioning-policy.md](versioning-policy.md) 기준 실험 표면.
- **hot-core** — 신 메커니즘: 네이티브 **dylib 스왑**(재빌드된 cdylib 을
  `DylibCore` 로 dlopen, 위 참고). 상태가 아니라 코어 코드 자체를 교체한다.

경험칙: hot_reload 는 상태를 교체(replace)하고, hot-core 는 라이브러리를
교체(swap)한다.

## parity gate

`rustra dev` 재빌드 게이트: reload 를 방출하기 전에 CLI가 codegen 전후의
contract hash 를 비교하고, 어긋나면 reload 를 아예 방출하지 않는다(fail-closed —
호스트는 구 엔진을 유지). config 키 `dev.wasm.parityGate` /
`dev.dylib.parityGate`, 기본값 `true`. 한국어 문서는 표기가 갈린다(parity
게이트, 정합 게이트, 정합성 게이트) — 모두 이 같은 게이트를 가리키며, 하나로
몰아쓰지 않고 이 항목으로 매핑한다.

## contract hash

**스키마 JSON만의** SHA-256 해시(`crates/rustra/src/package_schema.rs`의
`generated_contract_hash` — generation 카운터를 제외한 `generate_typescript()`
와 동일 입력). `rustra diff`, parity gate, `rustra_ffi_contract_hash`가 쓰는
계약의 신원이다. 한국어 문서는 contract hash, 계약 해시, 컨트랙트 해시를 섞어
쓴다 — 같은 것이다.

## dylib / cdylib

Rust 동적 라이브러리: `crate-type = ["cdylib"]`(C ABI 동적 라이브러리) 또는
일반적 dylib 개념. rustra에서 cdylib 산출물은 hot-core의 **핫스왑 단위**다 —
`rustra dev`가 빌드하고(`dev.target: "dylib"`) 호스트가 스왑 카피를 dlopen 한다.
릴리스 빌드는 무관하다: 정적 링크 경로는 그대로다.

## channel / ChannelHandle / binary channel

채널은 하나의 호출에 귀속된 유니캐스트 응답 스트림이다. `ChannelHandle`은
`u32` 뉴타입(`crates/rustra/src/channels_handles.rs`)이고, `ChannelHost`는
코어 측 발신 레지스트다(아래 **host** 참고). 바이너리 채널(JSON 문자열 대신
원시 바이트 프레임)의 팩토리 이름은 호스트별로 다르다 — 불일치가 아니라
설계다. 표준 계열:

| 호스트       | JSON 채널                | 바이너리 채널 팩토리          |
| ------------ | ------------------------ | ----------------------------- |
| React Native | `createChannel`          | `createBytesChannel`          |
| Tauri (web)  | `createChannel`          | `createChannelBytes`          |
| Node         | `createNodeChannel`      | `createNodeBytesChannel`      |
| Bun          | `createBunChannelBridge` | `createBunChannelBytesBridge` |

[events-and-channels.md](events-and-channels.md)(채널 절) 참고.

## host (호스트)

빈도순 네 가지 의미:

1. **임베딩 앱 / host adapter** (지배적) — Rust 코어를 품는 JS 런타임(Node,
   Bun, Tauri, React Native) 또는 그것을 섬기는 어댑터 패키지. "Host-neutral",
   "host adapter", "per-host"는 모두 이 뜻이다.
2. **`ChannelHost`** — 코어 측 채널/리소스 발신 레지스트리
   (`crates/rustra/src/channels_host.rs`). 의미 1과 거의 **반대**다: 이 host는
   코어 안에 살며 임베딩 앱에 핸들을 발급한다.
3. **JSI host 객체 / host function** — RN 네이티브 측: `invokeRkyvV2` 등을
   JavaScript에 노출하는 C++/TurboModule 객체.
4. **host promotions (호스트 승격)** — 와이어 에러가 JS throw 로 승격되는
   어댑터 측 지점들([wire-format.md](wire-format.md) 참고).

## snapshot

네 가지 의미:

1. **api-surface 스냅샷** — `scripts/api-surface.mjs`와
   `api-surface/snapshot.json`, 공용 API drift 게이트.
2. **`rustra_ffi_capture_snapshot`** — B1 인스펙터 와이어 덤프(실험 표면,
   [versioning-policy.md](versioning-policy.md)), `rustra inspect` 가 렌더링.
3. **디버그 로그 값 스냅샷** — `RUSTRA_DEBUG` 와이어 로그의 잘린 `value`
   필드([development-hurdles.md](development-hurdles.md)).
4. **`--snapshot canary`** — 발행 절차 카나리 단계의 changeset 스냅샷 발행
   ([release-procedure.md](release-procedure.md)).

## gate (단독)

"게이트"는 과적합 단어다. 계열:

- **게이트 프로파일** — dev/커밋/CI/릴리스 검증 단계
  ([dev-tier.md](dev-tier.md)).
- **capability 게이트** — deny-by-default `require_capability` + 런타임 부여;
  바이너리 채널 capability 협상(`channelBytes`).
- **drift 게이트** — 생성 파일/문서가 근원과 일치하는지 검증하는 CI 체크
  (codegen `--check`, `docs:sync` 리전).
- **릴리스 시점 게이트** — release-coherence·패키지 검증 스크립트.
- **runtime acceptance 게이트** — 어댑터별 안정 범위 게이트
  ([compatibility-contract.md](compatibility-contract.md)).
- **api-surface 스냅샷 게이트** — 위 snapshot 의미 1.
- **스크립트 이름** — `scripts/ci-gate.sh`, `scripts/docs-gate.mjs`,
  `scripts/onboarding-gate.mjs`.

## codec / Codec IR

**Codec** — 명령 I/O의 페이로드 직렬화기/역직렬화기(postcard codec, complex
codec, JSON codec, 생성 TS/C++ codec).
**Codec IR** — complex codec 이 컴파일되는 공유 스키마 중간 표현. TS·C++
제너레이터가 네이티브로 인코딩할 수 있는 형태를 판정한다
([complex-codecs.md](complex-codecs.md), [codegen.md](internal/codegen.md),
`crates/rustra/src/complex_codec_schema.rs`).

## mirror (미러)

세 가지 의미:

1. **문서 미러** — en/ko 쌍 관례: `*.md`에 `*.ko.md`를 긴밀히 미러링해 유지
   (docs/README.md 참고).
2. **수동 미러 (manual mirror)** — 문서 안에 손으로 관리하는 생성 데이터
   사본; rustra는 단일 소싱으로 이를 피한다(예: 디바이스 capability 카탈로그는
   수동 미러가 없다, [dev-tier.md](dev-tier.md)).
3. **동사** — "X mirrors Y": 한 표면이 다른 표면의 형태를 의도적으로 따른다
   (예: TS 인스펙터 타입은 blob 계약을 mirror 한다,
   [versioning-policy.md](versioning-policy.md)).

## subsecond

dioxus subsecond 핫리로드 기술. 네이티브 핫스왑 루프의 대안으로 검토하고
**현재는 보류/기각**(Tauri lib+bin 레이아웃 빈 패치 버그 dioxus#5778; 재평가는
Phase 4 항목). 아키텍처의 일부가 아니다 —
[plans/2026-09-09-native-hot-core-design.md](plans/2026-09-09-native-hot-core-design.md)
(대안 검토 절) 참고.

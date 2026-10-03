# 웜 루프 단축 접근 후보 분석 (2026-09-20)

상태: 검토용 제안(decision track — 아직 착수 결정 아님). 근거 문서:
[`2026-09-09-hot-core-loop-bench.md`](./2026-09-09-hot-core-loop-bench.md)(이하 "bench"),
[`2026-09-09-native-hot-core-design.md`](./2026-09-09-native-hot-core-design.md)(이하 "design").

> **출처 표기 정정.** sccache/mold/lld 기각은 design `L106-107`에 있다(bench
> `L106-107`은 host-entries 버그 섹션이다). bench의 기각 관련 기록은 없다. 본
> 문서는 수정된 출처로 인용한다.

## 1. 현재 병목 분해

### 1.1 측정값 재확인 (bench 문서 기준, 인용 라인 명시)

측정 조건: Apple M1 Max, 웜 cargo 캐시, n=40(2 run × 20), black_box 토글 편집
(bench `L20-30`, `L49-56`, `L250-252`).

| 구간                                |  p50 (run 2) |   p50 (n=40) | 근거                |
| ----------------------------------- | -----------: | -----------: | ------------------- |
| publish (게이트 + `-hot-live` 발행) |     2 534 ms |     2 565 ms | bench `L26`, `L210` |
| swap (publish → 호스트 보고)        |       935 ms |       929 ms | bench `L26`, `L211` |
| **total (edit → swap)**             | **3 478 ms** | **3 502 ms** | bench `L27`, `L212` |

목표 0.5~2 s 미달 — 판정 문구는 bench `L20`, `L32-34`, design `L112`, 요약은
design `L145-152`. run 2의 전체 spread가 365 ms(bench `L202-204`)라 150 ms
급 이상의 개선은 재측정으로 구분 가능하다.

bench의 병목 분해 표(bench `L216-222`) 재확인:

| 단계                                            |                  p50 | 점유율 | bench 근거                                      |
| ----------------------------------------------- | -------------------: | -----: | ----------------------------------------------- |
| watch debounce (`createWatchLoop` 300 ms)       |              ~300 ms |     9% | bench `L218`                                    |
| codegen cargo 단계 (`cargo run --bin generate`) |            ~2 100 ms |    60% | bench `L219` — `schemaGen 2.1s` 가 26/40 사이클 |
| TS 렌더 + dylib cargo + 게이트 + 발행           |              ~130 ms |     4% | bench `L220`                                    |
| 스왑 폴링 (sha256, 300 ms 간격)                 | 0~300 ms (평균 ~150) |    ~4% | bench `L221`                                    |
| 스왑 메커니즘 (copy+재서명+dlopen+init)         |              ~780 ms |    22% | bench `L222`, 단가는 `L225-231`                 |

### 1.2 코드 경로와의 정합 — 2.1 s 의 cargo 단계는 실제 무엇을 실행하나

config 모드 dylib 루프의 한 사이클(`packages/cli/src/dev.ts` `runConfigDev`):

1. **감시** — `manifestDir/src` 재귀 폴링(`dev.ts:246-250`), `Cargo.toml`/`Cargo.lock`
   (`dev.ts:251-256`), `schemaPath`(`dev.ts:257-270`). 감시 프리미티브는 fs.watch 가
   아니라 **100 ms 경로명 스냅샷 폴링**이다 — inode/size/mtime/ctime 지문
   (`watch.ts:171-197`, 인터벌 `watch.ts:162`, 의도 주석 `watch.ts:133-137`).
   bench `L57` 의 "(fs.watch + 300 ms debounce)" 표기는 코드와 어긋나는 옛 표현이고,
   분해에 쓰인 **300 ms 상수는 정확하다**(`watch.ts:79` debounce 기본값). 폴링
   전환은 감지 지연 상수 안에 흡수되므로 bench 수치는 유효하다.
2. **코드젠 cargo 단계(≈2.1 s)** — 이벤트는 곧 dirty(`dev.ts:358-360`, config 모드는
   `detectDirty` 를 쓰지 않는다) → `runCodegen`(`dev.ts:312-313`) →
   `cargo run --manifest-path <예제 매니페스트> --package rustra-calculator-example
--bin generate`(`cli-codegen.ts:130-141`, `RUSTRA_SCHEMA_OUT` 고정
   `cli-codegen.ts:128,144`). 이 `generate` bin 은 **사용자(예제) 크레이트의 lib 을
   링크한다**(`examples/calculator/src/bin/generate.rs:1`) — lib.rs 편집은 lib
   단위(rlib+cdylib+staticlib, `examples/calculator/Cargo.toml:8-9`)와 bin 단위를
   무효화하고, 첫 cargo 호출이 이 전부를 재컴파일한 뒤 bin 이 schema.json 을
   쓴다(`generate.rs:15`). 즉 **2.1 s 는 "스키마 코드젠 오버헤드"가 아니라 사용자
   크레이트의 사이클당 유일한 전체 재컴파일 비용이 첫 cargo 에 귀속된 값**이다.
3. **dylib cargo 단계(≈0.1 s)** — `buildDylibCore` 의
   `cargo build --lib --message-format=json`(`dev-dylib.ts:157-164`)은 첫 호출이
   이미 크레이트를 다 빌드했으므로 39/40 사이클에서 fingerprint-fresh no-op
   (bench `L220`, `L237-238`).
4. **게이트 + 발행** — schema 해시 사전 arm(`dev.ts:297-311`, `dev.ts:94-97`) →
   사후 verify, 실패 시 fail-closed 로 라이브 미발행(`dev.ts:326-344`) → 게이트
   통과분만 tmp+rename 발행(`dev.ts:345-348`, `dev-dylib.ts:227-252`).
5. **스왑** — 호스트 측 sha256 폴링 300 ms(`crates/rustra/src/hot_core_watch.rs:23-24,36,112`)
   → 버전 카피(~10 ms) + ad-hoc 재서명(~20-30 ms) + sha256(~10 ms) +
   `DylibCore::open` ≈0.7 s(11 MB debug cdylib dlopen + 코어 초기화 — **내부
   계측 없이 산술 잔여로 추정한 값**, bench `L224-231`).

### 1.3 프로필 정책의 적용 범위 — 이 문서의 중심 불확실성

이 저장소의 `[profile.dev]` 는 `debug = 1`, `incremental = false`이고 그 이유는
"의존성 debuginfo + 증분 캐시가 수십 GiB 로 자라는" 디스크 방어다
(`Cargo.toml:60-66`; `[profile.test]` 도 동일 `Cargo.toml:71-73`).
`examples/calculator` 는 이 워크스페이스 멤버(`Cargo.toml:6`)이므로 **bench 의
2.1 s 는 비증분 재컴파일의 값**이다. 반면 소비자 프로젝트는 별도 워크스페이스로
이 프로필의 영향을 받지 않고, cargo 기본값(dev 프로필 증분 = 로컬 크레이트 한정
on, `debug = 2`)으로 돈다. 즉 소비자의 실제 cargo 단계는 증분 덕에 더 빠를 수도,
debuginfo 비용 탓에 더 느릴 수도 있다 — **방향을 알 수 없고 측정 전이다.** 이
불확실성이 §2 전체와 §3 우선순위의 전제다. 한 가지 확실한 상계(upper bound):
fingerprint-fresh cargo 호출 전체가 0.1 s(bench `L220`)이므로 cargo 스폰+메타데이터
오버헤드는 ≲100 ms 다 — (c)의 천장 계산에 쓴다.

## 2. 접근 후보

### (a) 프로브 바이너리 증분 컴파일

**내용.** 사용자 크레이트 재컴파일(≈2.1 s, bench `L219`)에 cargo 증분 컴파일을
허용한다. 소비자 프로젝트는 **기본값이 이미 증분 on**이므로 할 일이 사실상
"소비자 레이아웃 실측"이다. 이 저장소 예제에 적용하려면 `[profile.dev]` 플립이
필요한데, cargo 프로파일 규약상 `incremental` 은 패키지별 override 가 불가한
전역 옵션이라(프로파일 override 허용 목록에 없음) 예제만 켜는 방법이 없다.
`CARGO_INCREMENTAL=1` env 로 codegen 스폰만 켜는 방법은 env 가 "끄는" 방향만
보장한다는 점(cargo 레퍼런스상 CARGO_INCREMENTAL=0 이 비활성)에서 프로필
`incremental=false` 를 되돌릴 수 있는지 **스파이크로 확인해야 하는 미확인
항목**이다. 별도 커스텀 프로필(`--profile hot-dev`)은 target 디렉터리가 갈라져
dylib 빌드와 fingerprint 를 공유 못 하게 되어 "두 번째 cargo 0.1 s"(bench
`L237-238`)를 깨뜨릴 수 있다 — 반(反)목표.

- **기대 효과** — 본문 전용 편집(black_box 토글류)에서 쿼리 재사용으로 cargo 단계가
  크게 줄 가능성. 다만 cdylib/staticlib 단위와 generate bin 재링크는 증분 이득이
  제한적일 수 있다. **추정: 2.1 s → 0.5~1.2 s**, 측정 전이다.
- **위험** — 이 저장소 플립 시 디스크(원래 정책 사유, `Cargo.toml:60-63`)와 증분
  캐시 부패 엣지; 소비자 쪽은 debug=2 의 debuginfo 비용이 증분 이득을 상쇄할 수 있음.
- **구현 비용** — 소비자 실측 스파이크: 반나절, 코드 변경 0. 이 저장소 정책
  변경: 디스크 실측 후 별도 결정.
- **기각/보류 사례와의 관계** — design `L106-107` 의 sccache 기각("증분+dylib
  캐시 불가")은 sccache 얘기이지 증분 컴파일 자체의 기각이 아니다. 이 저장소
  `incremental=false` 는 루프 성능 판단이 아니라 디스크 방어(`Cargo.toml:60-63`)
  로, 정책과 충돌이 아니라 **정책의 적용 범위 바깥(소비자)에서 먼저 검증**하는
  것이 정합적이다.
- **이 저장소 정책과의 충돌 검토(과제 항목)** — 소비자 기본값 증분은 이 저장소
  정책과 무관하다. 충돌은 "이 저장소 예제/벤치를 소비자와 같은 조건으로 재측정할
  때"만 생기며, 그 경우 (1) `[profile.dev]` 플립 + 디스크 실측, 또는 (2) 벤치
  문서에 "비증분 환경 수치"임을 명시하는 방향 둘 다 가능하다. (2)는 비용 0.

### (b) 변경 지문 기반 cargo 스킵

**내용.** 스키마 비영향(논리 전용) 파일 변경 시 codegen 의 cargo 단계를 건너뛴다.
전제 정정이 필요하다: mtime 기반 `detectDirty`(`dev-support.ts:25-47`)은 **레거시
`runDev` 경로에만 쓰인다**(`dev.ts:155-160`), dylib 핫 루프가 도는 config 모드는
모든 이벤트를 dirty 로 취급한다(`dev.ts:358-360` — 타임스탬프 비교가 삭제/설정
변경을 신뢰하게 추론 못 한다는 의도적 선택). 따라서 스킵은 config 모드
`perform`(`dev.ts:274-357`)에 넣어야 한다.

핵심 난점: 스키마는 **컴파일된 Rust 코드를 실행해야만** 나온다(`generate.rs:5-15`).
소스 텍스트 해시는 모든 편집에 변하고(무용), 시그니처만 보는 토큰 수준 지문은
struct 필드명·derive·attribute 변화까지 스키마를 바꾼다는 사실(rustra 매크로의
스키마 원천)을 반영하지 못해 **false-negative(스키마 변했는데 스킵)를 낸다.**
더 큰 문제: 스킵이 일어나면 parity 게이트는 무력화된다 — 게이트는 codegen 전후의
schema.json 해시 비교일 뿐(`dev.ts:94-97`, `dev.ts:326-344`) 빌드된 dylib 의
내장 계약 해시를 읽지 않으므로, "스킵 + 계약 변화"는 TS 와 어긋난 dylib 이
발행되고 invoke 시점 `contract.mismatch` 로만 드러난다(`cli-codegen.ts:37-45`).

- **기대 효과** — (b) 단독은 재컴파일을 없애는 게 아니라 첫 cargo 에서 dylib
  cargo 로 **옮길 뿐**이라(§1.2), 수득은 bin 단위 컴파일/링크+실행+TS 렌더+게이트
  점유분. **추정: 200~400 ms**(3.5 → ~3.1 s). (a)와 결합 시 논리 전용 루프의
  상한을 만드는 보조 레버.
- **fail-safe 방안(과제 항목)** — 스킵을 "사후 검증형"으로 뒤집는다: 스킵 시에도
  dylib 빌드는 하고, 그 산출물이 export 하는 C ABI 심볼 `rustra_ffi_contract_hash`
  (design `L32-35` — blob C ABI 일부)를 읽어 마지막 codegen 시점 해시와 비교해
  어긋나면 전체 codegen+게이트를 강제 재실행한다. false-negative 가 "조용한
  불일치"가 아니라 "1 사이클 낭비 + 자가 치유"로 바뀐다. 시나리오 실측(design
  `L177-194`)이 논리 전용=해시 불변을 보증하므로 판정 기준으로 유효하다.
  미해결 질문: CLI 프로세스가 이미 빌드된 cdylib 에서 심볼을 읽는 방법(dlopen vs
  `nm -gU` 파싱)과 비용 — 프로토타입 필요. 11 MB 산출물 대상 수십 ms 로 추정.
- **위험** — 지문 도구의 유지보수(토크나이저가 매크로 진화를 따라가야 함),
  스킵 경로의 게이트 우회 인상. fail-safe 가 정책(design `L77-83` fail-closed)을
  확장하는 형태임을 문서화로 정리 필요.
- **구현 비용** — 중간. config `perform` 분기 + 지문기 + 심볼 판독 + 테스트.
- **기각/보류 사례와의 관계** — 선행 문서에서 다룬 적 없는 신규 축이다. 단,
  bench `L269-271`("codegen 은 스키마 불변 편집에 바이트 안정")이 이 아이디어의
  실증적 뒷받침이다.

### (c) 상주 프로브/스키마 서버

**내용.** probe/schema 생성기를 상주시켜 cargo 런치 비용을 제거한다.

- **근본 제약(과제 항목 검토)** — 계약 프로브는 사용자 크레이트를 다시 컴파일해야
  한다: 스키마는 사용자 크레이트에서 컴파일된 코드의 실행 결과고(`generate.rs:5-15`),
  소스 편집은 그 기계어를 무효화한다. 상주 프로세스는 rustc 호출을 대체할 수
  없고(증분 재컴파일도 cargo/rustc 프로세스가 필요), 제거 가능한 것은 스폰
  오버헤드뿐이다. 그 상계는 §1.3 의 bound 대로 **≈100~200 ms(추정)** — cargo
  호출 전체가 no-op 일 때 0.1 s(bench `L220`)인 것과 bin 실행 수십 ms.
- **기대 효과** — 천장이 너무 낮아 목표(≥1.5 s 절감) 도달 경로가 아니다.
- **위험/비용** — 상주 프로세스의 신선도 계약(스킵보다 나쁜 stale 위험), 세션
  수명 관리, 플랫폼별 dlopen/IPC 복잡도. 비용 대비 수득 최하.
- **기각/보류 사례와의 관계** — design 의 subsecond/hot-lib-reloader 기각
  (`L100-103`)과 같은 "복잡도 대비 소득 불량" 논리로 **보류**가 적절하다.
  (a) 실측에서 스폰 오버헤드가 예상 외 크게 나오면(≈100 ms 상계 붕괴) 재검토.

### (d) cargo 런치 단가 절감 — 기존 기각 재검증

design `L106-107` 의 세 항목과, 기각에 포함되지 않은 프로파일 축을 나눠 본다.

- **sccache** — 기각 유효. 실제 편집은 매번 유일한 입력이라 캐시 히트율 ≈ 0
  (bench 의 2-state 토글 `L53-56`, `L257-259`은 인공 상황에서만 유리), 증분과도
  비조합. 재검증 불요.
- **mold** — 기각은 이제 더 강하다. 2026-09-20 재확인: mold 의 Mach-O 포트는
  중단됐고(ELF 전용, macOS 는 별도 비자유 판), Apple 의 신형 시스템 링커(ld-prime)
  수요를 흡수했다. macOS 루프에 선택지 자체가 없다.
- **lld** — design `L106` 의 "기본 링커보다 느림"은 **측정이 아니라 단언**이었다는
  것이 유일한 약점. 다만 2.1 s 가 rustc 컴파일과 링크로 분해된 적이 없어 링크
  점유율 자체가 미지수다. `cargo build --timings` 로 codegen 단계를 단위별
  분해하는 것으로 종결 가능(§3 Stage 0). 링크가 <15% 면 기각 확정, 크면 lld
  시행이 플래그 하나다.
- **(신규) 프로파일 축 — 기각 대상이 아니었다** — bench 는 `debug=1`
  (`Cargo.toml:64-66`)에서 측정됐고 소비자 기본값은 `debug=2` 다. debuginfo
  codegen 비용 + 산출물 비대(11 MB)는 컴파일·링크·dlopen(`L227-231`의 ≈0.7 s)
  모두에 불리하게 작용한다. 소비자 템플릿에 "핫 루프용 프로필 가이드
  (debug=1, strip=debuginfo 유지)"를 문서화하는 비용은 거의 0. **효과 추정:
  100~400 ms**, 미측정. 같은 축에서 hot 루프가 dlopen 하는 것은 cdylib 뿐인데
  예제 lib 은 staticlib 까지 빌드한다(`Cargo.toml:8-9`; cargo 는 crate-type 일부만
  빌드하는 플래그가 없다) — crate-type 절감은 소비자 크레이트 구성 가이드로만
  가능하고, 점유율은 --timings 분해 후 판단.

### (e) subsecond 재평가 트리거

기각·보류 근거: design `L100-101`(워크스페이스 패칭은 착지 — dx ≥ 0.7.4 — 했으나
Tauri lib+bin 레이아웃에서 조용히 빈 패치 + dx 강제 종속), `L104-105`(cranelift
macOS unwind 미지원 → panic=abort → `with_panic_guard` 무력화), `L171-174`
(2026-09-10 재평가 — 세 조건 모두 미충족 판정), `L94-95`(Phase 4 트리거 정의).

**명시적 재검토 조건 목록** (2026-09-20 상태 재확인 포함):

1. **dioxus#5778 종결 + 수정판 릴리스** — Tauri lib+bin(tip) 레이아웃에서 빈 패치
   버그. 2026-09-20 기준 **여전히 오픈**, 수정 PR #5779 도 오픈/미머지, 불량
   필터는 v0.8.0-alpha.1 까지 유지됨(회귀 원천 PR #5479). 조건: 이슈 종결 + 수정
   버전 릴리스 + `examples/hot-core-probe` 레이아웃에서 패치 비어있음 재현이
   소멸하는지 2-crate 프로브로 확인.
2. **dx 강제 종속 수용 판정** — design `L101` 의 dx 종속을 Tauri 앱에 끌어들이지
   않고 쓸 수 있거나, 비용을 명시적으로 수용하는 결정.
3. **cranelift: macOS unwinding 기본 활성화** — 트래킹 이슈 #1567. 2025-06 진행
   보고 기준 실험 브랜치 단계·기본 비활성(2026-09-20 재확인). `with_panic_guard`
   보존을 위해 **하드 조건**이다(design `L104-105`).
4. **cranelift: ctor 버그** — rustc_codegen_cranelift#1588. 2026-09-20 재확인
   결과 **종결됨**(수정 = `mod_init_funcs` 지원 구현). design `L171-174` 의
   "오픈" 기록에서 상태 갱신이 필요하다. **단, 3이 남아 있어 단독으로는
   재평가 트리거가 아니다.**

재평가 판정 기준(트리거 발화 시 공통): design `L177-194` 의 4 시나리오 전체
통과 + 웜 루프 벤치(bench 프로토콜 재사용)에서 total p50 < 1 s.

### (f) 스왑 0.93 s 측 — 게이트 유지 전제

구성(bench `L221-231`): 폴링 평균 ~150 ms + copy ~10 ms + 재서명 ~20-30 ms +
sha256 ~10 ms + `DylibCore::open` ≈0.7 s(**미계측 잔여 추정치**, `L229-231`).

- **폴링 간격 300→100 ms + stat-precheck** — bench `L240-242` 가 반납 시
  ≈75-150 ms 로 계산했다. 현재 감시는 300 ms 마다 11 MB 전체 sha256 이다
  (sha256 전용 폴링은 design `L122-124` 의 의도적 단순화; `hot_core_watch.rs:36,112`).
  CLI 측 `watch.ts` 와 같은 지문 패턴(`ino:size:mtime:ctime`, `watch.ts:179`)을
  stat-precheck 로 쓰면 — stat 이 변했을 때만 해시 — 100 ms 폴링을 CPU 무시
  수준으로 유지할 수 있다. parity 게이트(CLI 측, `dev.ts:326-344`)와 무관한
  호스트 프리미티브라 게이트 유지 전제에 위배 없음. **수득 추정 ~100-150 ms.**
- **open/init 계측과 절감** — ≈0.7 s 잔여는 dlopen 과 코어 초기화(패키지 등록,
  계약 해시 바인딩)가 묶여 있다. `DylibCore::open` 내부에 env 게이트 타이밍
  계측(`RUSTRA_HOT_CORE_TIMING=1`)을 넣는 후속 작업이 선행 필요(본 문서 화이트
  리스트 밖 — crates/ 수정 불가, 제안으로만 기록). dlopen 이 지배하면 산출물
  크기가 레버(debug 수준 — (d)와 결합), 초기화가 지배하면 등록 지연화가
  레버. **천장 추정: 0.93 s → 0.5~0.6 s.** (f)만으로는 publish 2.5 s+ 가 남아
  목표 도달 불가 — 보조 레버다.
- **스코프 밖 확인** — 구 코어 leak(dlclose 금지, design `L64-66`)과 코드 copy/
  재서명 단가(`L225-227`)는 이미 최소 — 대상 아님.

## 3. 권고안

**1순위 — (a) 소비자 레이아웃 실측 스파이크(구현 아님, 측정).**
cargo 단계 ≈2.1 s(60%)는 증분 컴파일이 직접 공격하는 유일한 대규모 비용이고,
bench 가 이 저장소의 비증분·debug=1 환경(`Cargo.toml:60-66`)에서 나왔다는 사실은
**모든 소비자 지향 투자의 전제(2.1 s 가 소비자 실제인지)가 미검증**임을 뜻한다.
반나절, 코드 변경 0 으로 이후 모든 의사결정의 분기점을 얻는다.

**2순위 — (b) 스킵 + 아티팩트 계약 해시 사후 검증.** (a) 실측 후 cargo 단계가
논리 전용 편집에서 여전히 ≥1 s 면 착수. (a)의 수득에 200~400 ms(추정)를 곱하는
보조 레버이고, fail-safe 설계(design `L77-83` 정책의 확장)가 핵심이다.

**덤 — (f) 폴링 stat-precheck + 100 ms.** 비용 최소, 게이트 무관, ~100-150 ms.
(b)와 무관하게 즉시 가능하나 단독으로는 판정에 닿지 않는다(bench `L240-242`).

미채택: (c) 천장 ≈100~200 ms 로 제외(재검토 조건 §2c), (d) 링커 3종은 기각
유지(mold 는 영구, sccache 유효, lld 는 --timings 분해로만 재열림), 프로파일
가이드는 (a) 실측 결과에 붙여 문서화.

### 실측 계획

**Stage 0 — 소비자 레이아웃 A/B/C (스파이크, 코드 변경 0)**
별도 임시 워크스페이스(소비자 모사)에서 bench 프로토콜(bench `L49-68`,
`L279-291` — 동일 black_box 토글, 2 warmup + 20 measured × 2 run)로 매트릭스
측정: {incremental on/off} × {debug 1/2}. 기록: `schemaGen`/`dylibBuild` 스텝
타이머 + publish/swap/total p50·p95 + `target/` 디스크 증분(이 저장소 정책
플립 판정용). codegen 단계에 `cargo build --timings` 를 얹어 단위별 분해
(rlib/cdylib/staticlib/bin/링크 점유율)를 함께 수집 — (d)의 lld 재판정과
crate-type 절감 판단 재료.

- 판정 1: 소비자 기본값(증분 on, debug 2)에서 cargo 단계 p50 ≤ 1.2 s → 루프
  예상 ≈2.6 s(추정). (b)+(f)로 2 s 이하 경로 성립 → 이 저장소 정책 변경 불요,
  (b) 착수.
- 판정 2: cargo 단계 ≥ 1.5 s 유지 → 증분이 cdylib/staticlib 단위에 효과 없음.
  --timings 분해 결과에 따라 crate-type 절감/프로파일 가이드/(d) 재검으로 분기.
- 판정 3: 스폰 오버헤드(즉 fresh-cargo no-op 시간)가 ≫100 ms → (c) 재검토.

**Stage 0 부분 실측 결과 (2026-09-20, 본 문서 착지 시 수행)**

벤치 프로토콜 전체(publish/swap 포함, debug 1/2 매트릭스)가 아니라 그 첫 축인
**코드젠 cargo 단계만**을 소비자 레이아웃에서 측정했다. 환경: 저장소 밖
독립 크레이트(/tmp, rustra path dep, 소비자 기본 프로필 — 증분 on, debug 2),
의존성 캐시 후 `touch src/bin/generate.rs → cargo run --bin generate` wall
time, A(증분 on)/B(`CARGO_INCREMENTAL=0`) 교차 반복(순서 드리프트 통제).
user/sys 어카운팅은 실행 환경 특이로 신뢰 불가 — 판정은 wall time 교차
비교로 한다.

| 크레이트 규모    | A(증분 on) p50              | B(증분 off) p50                | no-op floor |
| ---------------- | --------------------------- | ------------------------------ | ----------- |
| 최소(커맨드 1개) | 0.24 s (n=5, 0.23–0.26)     | 0.33 s steady / 첫 전환 2.35 s | ≈0.05 s     |
| 합성 150 커맨드  | **1.49 s** (n=7, 1.48–1.51) | **6.6 s** (n=7, 6.58–6.65)     | ≈0.10 s     |

- 소비자 기본값에서 cargo 단계는 규모에 따라 0.3 s(최소)~1.5 s(대형 합성) —
  bench의 2.1 s 는 이 저장소의 `incremental=false` 프로필이 만든 불리한 값으로
  확정됐다(§1.3의 중심 불확실성 해소).
- 150 커맨드 규모에서 증분 효과는 **약 4.4배**(6.6 s → 1.5 s), 분산 0.1 s 이내.
  판정 1의 "≤ 1.2 s" 는 대형 규모에서 미달, 판정 2의 "≥ 1.5 s" 경계에 정확히
  걸린다 — 즉 **규모가 커질수록 cargo 단계가 루프를 다시 지배**한다.
- 시사점: (b) 변경 지문 기반 스킵의 수득 추정(200–400 ms)은 보수적이었다 —
  스킵 성공 시 루프가 floor(≈0.1 s)+스왑으로 수렴하므로 대형 크레이트에서 수득이
  수 초 규모로 커진다. (a)의 이 저장소 정책 플립은 `target/` 디스크 증분을
  측정한 뒤 별도 판단(본 실측은 미측정).

**Stage 1 — (b) 프로토타입(판정 1 경로일 때)**
스킵 + `rustra_ffi_contract_hash` 사후 비교 fail-safe. 40사이클 정상 루프 +
**오염 시나리오 5종**(필드 추가/필드명 변경/타입 변경/attribute 제거/derive
변경)에서 게이트·사후 검증의 포착률 100% 요구.

- 판정: false-negative 0 그리고 논리 전용 total p50 ≤ 2 s.

**Stage 2 — (f) 폴링 전환**
`hot_core_watch.rs` stat-precheck + 100 ms(또는 옵션화). 40사이클 재측정.

- 판정: swap p50 ≤ 0.8 s 그리고 유휴 호스트 CPU 증가 무시 가능(체감/프로파일
  <2% 코어). 미달 시 300 ms 유지.

**Stage 2 결과 (2026-09-21, 착지 시 수행)**

(f) 착지 — 폴링을 300 ms 전체 sha256 조사에서 **100 ms stat 지문(ino:size:
mtime:ctime 계열, CLI `watch.ts`와 같은 지문 계열) 사전 검사 + 변화 시에만
sha256**으로 전환했다. `DylibWatchConfig::poll` 기본 300 ms → 100 ms(필드
오버라이드 유지). 판정 실측(bench 프로토콜 그대로 2 run × 20 사이클 + 30초
유휴 샘플, 동일 기계):

| 지표                             | 전환 전                              | 전환 후          | 판정       |
| -------------------------------- | ------------------------------------ | ---------------- | ---------- |
| swap p50 (publish → 호스트 보고) | 929 ms(bench 문서, 300 ms 전량 폴링) | **468–492 ms**   | ≤ 0.8 s ✅ |
| 유휴 호스트 CPU                  | (미측)                               | **0.0 %** (30 s) | < 2 % ✅   |

- swap 개선은 추정(~100–150 ms)을 크게 웃돈다 — §1.1의 ≈0.7 s
  `DylibCore::open` 산술 잔여 추정이 실측에서 훨씬 작았던 것으로 본다(잔여
  추정치의 과대 평가). total p50은 여전히 3.58–3.64 s — cargo 단계가 지배.

**(a)의 루프 내 해결 (2026-09-21, 프로필 플립 아님)**

(a)이 검토하던 "이 저장소 `[profile.dev]` 플립"은 스파이크에서 env 우선순위가
확정되며 다른 결론을 얻었다. 실측 3가지(임시 크레이트, 저장소 밖):

1. `CARGO_INCREMENTAL=1` env는 프로필 `incremental = false`도 뒤집는다
   (cargo 레퍼런스의 "끄는 방향만 보장" 통설과 달리 **양방향 우선**).
2. `CARGO_INCREMENTAL=0` env는 프로필 `true`를 끈다(rust-cache CI가 기대하는
   방향 — 확인).
3. 증분 여부는 cargo 핑거프린트에 없다 — env 유무를 바꿔도 재컴파일 0건,
   이미 만든 증분 캐시는 유지된다.

이에 `rustra dev` 루프가 도는 cargo 스폰(스키마 generate bin, dylib 빌드)에만
`CARGO_INCREMENTAL=1`을 주입한다(dev.ts 진입점, 사용자 env가 이미 정의되면
존중). 프로필 플립 대비 이점: 일반 빌드·테스트의 디스크 방어 정책(`Cargo.toml`
주석)은 그대로이고, rust-cache CI(자동 `CARGO_INCREMENTAL=0`)는 무변화이며,
소비자 기본값(증분 on)도 무변화다 — 이 저장소 루프만 Stage 0의 증분 이득을
받는다.

결합 실측((f)+(a), bench 프로토콜 2 warmup + 20 사이클, 동일일 동일기계
비교):

| 지표 (p50)          | 비증분 + 300 ms 폴링 |      (f)만 |       (f)+(a) |
| ------------------- | -------------------: | ---------: | ------------: |
| publish             |             3 125 ms |   3 125 ms |  **2 497 ms** |
| — cargo schema 단계 |            2.6–2.8 s |  2.6–2.8 s | **2.0–2.1 s** |
| swap                |      (문서값 929 ms) | 468–492 ms |    **477 ms** |
| total               |             3 636 ms |   3 636 ms |  **2 941 ms** |

- 증분 수득이 Stage 0 소비자 실측(4.4배)보다 작은 이유는 §2a 위험 노트가
  예견한 그대로다 — calculator 예제는 본문이 작아 cargo 단계가 rlib+cdylib+
  staticlib+bin **재링크**로 지배되고, 링크는 증분 대상이 아니다. 본문이 큰
  소비자일수록 수득이 커지고, 링크 지분은 (d)의 crate-type 가이드(README
  "Warm-loop speed")로 줄인다.
- 디스크: 웜 루프 정상 상태의 증분 캐시는 `target/debug/incremental`
  ≈ 253 MB(22사이클 뒤). 콜드 풀빌드 최악값(예제+의존성 전부, 격리 target
  디렉터리 A/B)은 **+104 MB(432 MB → 536 MB, 약 +24 %)** — 프로필 주석의
  "수십 GiB" 우려는 다중 호스트·트리플 전체를 누적 빌드하는 이 저장소 target
  규모의 이야기이고, 루프 스폰 한정 주입의 증분 한 프로필분은 이 정도다.

## 부록 — 2026-09-20 외부 상태 재확인 링크

- dioxus#5778 (오픈, PR #5779 미머지): https://github.com/dioxuslabs/dioxus/issues/5778
- rustc_codegen_cranelift#1588 (ctor/mod_init_funcs — **종결**):
  https://github.com/rust-lang/rustc_codegen_cranelift/issues/1588
- cranelift unwinding 트래킹 #1567 (WIP·기본 비활성):
  https://github.com/rust-lang/rustc_codegen_cranelift/issues/1567 ,
  https://bjorn3.github.io/2025/06/27/progress-report-mid-2025.html
- mold Mach-O 중단(ELF 전용): https://github.com/rui314/mold/issues/1171

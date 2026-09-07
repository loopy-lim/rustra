# 2026-09-08 문서 사용성 감사 (docs usability audit)

- **문제 정의(사용자 진술)**: "docs가 결국 읽는 사람이 어떻게 써야 하는지 잘 모르는 것 같다" — 독자가 *내 상황에서 무엇을 어떻게 쓰는지*를 문서에서 얻지 못한다.
- **감사 범위**: `docs/` 전체(하위 `extending/`, `internal/`, `migrations/` 포함) + 루트 `README.md`/`README.ko.md` + `examples/` 10개 예제의 문서 연결. en/ko 미러는 양쪽 모두 확인했다.
- **방법**: 4개 페르소나 여정 검토 → 결손 유형 (a)~(f) 분류 → file:line 실측 근거 목록화 → 구조 제안.
- **기준일**: 2026-09-08, 워크스페이스 버전 0.8.0(`Cargo.toml` root, `packages/types/package.json`), 본 문서는 다른 감이 작성 중인 `2026-09-08-zero-config-dx-audit.md`와 독립적이며 문서 사용성에만 집중한다.

---

## 1. 핵심 진단

문서의 절대량과 정확성 관리(docs:sync 게이트, `README.md:103-105`)는 이미 상당한 수준이다. 그럼에도 "어떻게 써야 하는지 모르겠다"는 결론이 나오는 원인은 세 가지다.

1. **사용법의 최종 진실이 문서들 사이에서 어긋난다.** 대표 사례: getting-started 본문(§4)은 "엔진을 직접 만들지 않는다"고 말하고 마지막 요약 다이어그램(getting-started.md:1140)은 `createXxxEngine(transport) + configure(engine)`를 지시한다. 러스트 앱 개발자가 문서를 끝까지 읽으면 첫 호출 코드를 두 방식 중 어느 쪽으로 써야 하는지 알 수 없다.
2. **"내 상황"에 해당하는 분기 안내가 없다.** 호스트별(Tauri/RN/Node/Bun), 경로별(외부 프로젝트 vs init vs 모노레포), 버전별(0.6/0.7/0.8) 분기가 각기 다른 문서에 흩어져 있고, 한 문서 안에서 "당신이 X라면 이 순서로"라는 배열이 없다.
3. **예제와 레퍼런스가 서로를 가리키며 끝나는 경우가 많다.** `examples/`에는 좋은 README가 10개 있으나 `docs/README.md`에는 examples가 한 번도 등장하지 않고(grep 결과 0건), 반대로 API 레퍼런스의 구멍(`.event()` 빌더, invokeBatch 사용법)은 예제 소스 코드에서만 답이 존재한다.

---

## 2. 페르소나별 여정 검토

### P1 — RN 앱 개발자, Rust 처음

- **진입**: `docs/README.md:9-17`의 추천 경로는 Architecture(548줄)를 Getting Started 앞에 둔다. "10분 안에 첫 패키지"(getting-started.md:7)를 약속하는 문서집의 읽기 순서가 개념 문서부터 시작해 약속과 어긋난다.
- **첫 코드 충돌**: README "Quick Example"(README.md:184-205)은 `#[bridge_type]` + `rustra::build!`를 쓰는데, getting-started §2(getting-started.md:115-130)는 수동 derive 3종만 가르치고 `bridge_type`을 한 번도 언급하지 않는다(grep 0건). P1은 같은 일을 하는 두 문법을 다른 문서에서 순서 없이 만난다.
- **막히는 지점**: RN 절 자체(getting-started.md:756-831)와 `extending/react-native-setup.md`는 잘 되어 있다. 그러나 (1) 전제 조건( Bun 최소 버전은 react-native-setup.md:68에만, MSRV는 versioning-policy.md:70-73에만 존재)이 산재하고, (2) UI부터 만들고 싶을 때 FAQ(README.md:139-141)가 약속하는 `@rustra/testing` mock engine 사용법이 사용자 문서 어디에도 없다.
- **환각 위험**: getting-started.md:836-844의 RN JSON 경로 예제는 `./native-transport`에서 `customNativeTransport`를 import하는데, 이걸 어떻게 만드는지에 대한 문서가 없다.

### P2 — Tauri 데스크톱 앱 개발자

- **경로 존재 여부**: 부분적으로만 존재한다. 필요한 조각은 모두 있으나 5개 문서에 분산: getting-started.md:725-753(생성 엔트리/등록), README.md:580-615(어댑터/withGlobalTauri), transport-guide.md:144-178(rustra_dispatch), platform-permissions.md:40-53(ACL/CSP), examples/tauri-calculator/README.md(전체 예).
- **결정적 결손**: "기존 Tauri 앱에 얹기" 워크스루가 없고, `app.withGlobalTauri`를 켜는 실제 스니펫(`tauri.conf.json`)이 사용자 문서에 없다 — 실제 JSON은 오직 예제 저장소(examples/tauri-calculator/src-tauri/tauri.conf.json:10)에만 있다. P2는 문서만으로는 수정할 파일 목록(Cargo.toml feature / src-tauri/main.rs / tauri.conf.json / rustra.json / 프런트엔드 import)을 한 번에 볼 수 없다.

### P3 — Rust 개발자, 라이브러리 작성 → JS 팀에 배포

- **명령 작성→스키마→코드젠** 코어 경로는 존재한다(getting-started §2, rust-api-guide §2-7). 그러나:
  - `rustra.json`을 init 없이 만드는 방법이 명시적으로 없다(README.md:207-213은 파일이 만들어지기 전에 `--config rustra.json`을 실행하게 한다).
  - Node 표준 런타임이 구현해야 하는 stdio 프로토콜 `{command, args} → {ok, result}` + `__rustra_contract`(getting-started.md:679-686)의 복사 가능한 구현이 메인 경로에 없고 "예제를 보라"로 끝난다(인라인 코드는 transport-guide.md:75-91에만, 그것도 "교체 가이드"라는 엉뚱한 문맥에서).
  - 이벤트 계약 작성법 `PackageBuilder::event::<T>()`가 rust-api-guide의 빌더 메서드 표(rust-api-guide.md:341-351)에 없다. 유일한 안내는 예제 소스 주석(examples/streaming/src/lib.rs:13)과 로드맵 한 줄(README.md:53)이다.
  - "JS 팀에 배포" 단계(generated/ 커밋 정책, 스키마 전달, 버전 고정)를 다루는 문서가 없다. versioning-policy.md는 rustra 자체의 버전 정책이지 사용자의 배포 가이드가 아니다.
- **무서운 함정**: transport-guide의 Bun FFI 예제(transport-guide.md:259-298)가 2026-09-03 legacy removal로 제거된 심볼 `rustra_calculator_invoke`/`rustra_calculator_free_string`을 "현재 구현"으로 가르친다(아래 결손 #9).

### P4 — 평가자(도입 검토)

- **5분 평가**: README의 비교표(README.md:29-47)·FAQ(README.md:132-156)·성능표(README.md:667-674)는 충실하다. 다만 설치 버전 신호가 3개로 갈린다(아래 결손 #1): 설치 스니펫 `rustra = "0.6"`(README.md:166), 내부 TODO 주석 "발행 시 갱신: 0.7.0 라인"(README.md:162), 검증 조합 "0.8.x"(compatibility-matrix.md:58). 평가자는 "지금 무엇을 설치해야 하는가"에 대해 문서집 안에서 단일한 답을 얻지 못한다.
- **기능 지원 여부**: 기능×어댑터 매트릭스가 **표 2개로 중복 수록되어 서로 모순**된다(아래 결손 #2). "내 호스트에서 채널/이벤트가 되는가"라는 도입 의사결정 질문에 문서가 두 개의 반대 답을 준다.

---

## 3. 결손 유형 정의 및 빈도

| 유형 | 정의 | 건수(아래 목록 기준) |
| --- | --- | --- |
| (a) 개념은 있으나 실행 단계 없음 | 무엇인지는 설명하나 "어디에 무엇을 두고 무엇을 실행할지" 단계가 없음 | 10 |
| (b) 코드 조각은 있으나 어디에 두는지 불명 | 스니펫은 있으나 파일 경로/임포트/설정 위치가 특정 안 됨 | 5 |
| (c) 버전/호스트 조건 분기 안내 부재 | 버전·호스트·프로파일에 따라 다른 안내가 없거나 상충 | 6 |
| (d) 예제(또는 타 문서)와 불일치 | 문서 간/문서-코드 간 내용이 모순되거나 스테일 | 10 |
| (e) 진입점 부재(링크는 있으나 도달 불가) | 인덱스/링크가 없어 문서나 예제에 도달할 수 없음 | 4 |
| (f) 용어 정의 없이 사용 | 처음 등장한 용어의 정의/링크 없이 사용 | 4 |

---

## 4. 구체 결손 목록

형식: **독자 질문 → 지금 문서가 주는 답 → 결손 → 수정 제안**. en/ko 동일 결손는 en 좌표만 표기하고 (ko 동일)로 병기했다.

### 4-1. 루트 README.md / README.ko.md

1. **[c/d] 지금 어떤 버전을 설치해야 하나?**
   → 답: `rustra = "0.6"`(README.md:164-169), 내부 주석 `<!-- 발행 시 갱신: 0.7.0 라인 -->`(README.md:162, 584 / README.ko.md:142, 544 / getting-started.md:42 / getting-started.ko.md:41). 한편 호환 매트릭스는 "npm 0.8.x ↔ Rust 0.8.x가 CI에서 검증된 조합"(compatibility-matrix.md:58)이라 하고 워크스페이스 실측은 0.8.0이다.
   → 결손: 버전 신호가 3갈래(0.6 설치줄 / 0.7.0 갱신 TODO / 0.8.x 검증)이고, TODO 주석이 독자-facing 파일에 그대로 노출된다.
   → 제안: 설치 스니펫을 게시 버전으로 갱신하고 TODO 주석 제거. 설치 절에 "검증 조합 표" 한 줄(매트릭스 #58과 동일 문장)을 추가해 단일 진실 지정.

2. **[a] Quick Example을 따라가다 `rustra codegen --config rustra.json`을 만났다. rustra.json은 언제 만들었지?**
   → 답: README.md:207-213은 코드젠을 실행하게 하나, 비-RN 경로의 rustra.json 전체 생김새는 훗날 README.md:273-281에 나온다. "이 파일을 먼저 만들어라"는 단계가 없다.
   → 결손: 첫 실행 경로에서 필요한 파일의 생성 시점이 누락(유형 a).
   → 제안: Quick Example 바로 아래 "rustra.json 최소형"(스키마/출력/호스트 키)을 4줄 JSON으로 먼저 보여주고 코드젠 명령을 그 다음에 배치.

3. **[d] README의 첫 Rust 코드와 getting-started의 첫 Rust 코드가 다르다. 어느 것이 표준인가?**
   → 답: README.md:184-205은 `#[bridge_type]`+`build!`, getting-started.md:115-181은 수동 derive+`Package::builder`/`register!`. getting-started에는 bridge_type 언급이 0회다.
   → 결손: 같은 입구 문서들이 상이한 "첫 문법"을 가르치고 상호 관계(bridge_type = derive 3종+rename_all의 슈가, rust-api-guide.md:179-194)를 첫 접점에서 설명하지 않는다.
   → 제안: getting-started §2-1 직후에 "축약형: `#[bridge_type]`이 이 3줄을 대신한다" 박스 1개 추가(이미 rust-api-guide §3에 있는 내용을 첫 접점으로 이동).

4. **[a] 취소/타임아웃/배치는 실제로 어떻게 호출하나?**
   → 답: 개념은 README.md:513-523(AbortSignal), rust-api-guide.md:538-541(timeoutMs), compatibility-matrix.md:50-54(invokeBatch)에 산재하나 `invoke(cmd, args, { signal })`, `invokeBatch([...])`의 완전한 JS 호출 예제가 문서집에 하나도 없다(`invokeBatch(` 호출부 grep 0건, `BatchEntry` 형태는 architecture.md:78 타입 정의뿐).
   → 결손: 시맨틱 문서는 풍부하나 사용 코드가 없음(유형 a).
   → 제안: rust-api-guide 또는 신규 "런타임 시맨틱" 절에 signal/timeoutMs/invokeBatch 각 3~5줄 완전한 호출 예제 추가.

5. **[e] React에서 쓰고 싶다(@rustra/react).**
   → 답: README.md:404 구조 목록에 이름만 존재. useCommand/useMutation/useEvent/RustraProvider 사용법 문서가 docs/에 없다(예제 examples/reference-app/README.md만 존재).
   → 결손: 공개 패키지의 사용법 진입점 부재.
   → 제안: docs/에 "React hooks 가이드" 1페이지(또는 reference-app README로의 명시 링크 목록) 추가 후 README 패키지 표에 연결.

6. **[c] CLI는 어떻게 실행하는 것이 표준인가?**
   → 답: `bunx --bun @rustra/cli ...`(README.md:751), `rustra diff ...`(migration-guide.md:15, 전제 설명 없음), `bun run doctor`(development-hurdles.md:37, init 스크립트 전제)이 혼용된다. `bun add -d @rustra/cli` 안내는 RN 문맥에만 있다(README.md:250).
   → 결손: CLI 설치/실행 형태의 정식 안내 부재.
   → 제안: development-hurdles 상단에 "CLI 실행 3형태(전역/디펜던시/bunx)와 권장형" 3줄 정리.

### 4-2. docs/getting-started.md / .ko.md

7. **[d] "보통 앱은 엔진을 만들지 않는다"고 했는데 마지막 다이어그램은 configure()를 하라고 한다.**
   → 답: §4 "Ordinary apps do not build an engine or call configure() themselves"(getting-started.md:660-664) vs 요약 "call createXxxEngine(transport) + configure(engine) + addNumbers(input)"(getting-started.md:1140, ko 1126).
   → 결손: 문서 내부 자기모순으로, 독자가 최종적으로 남기는 인상이 "직접 configure 해야 한다"가 되게 만든다(마지막 줄이므로).
   → 제안: 요약 다이어그램 마지막 단계를 "import the generated host entry → addNumbers(input)"으로 교체하고, configure()는 "탈출구(§4 각 호스트)" 각주로 이동.

8. **[d] 요약표의 성능 수치와 본문/README가 다르고, 각주의 24/27µs는 표에 없다.**
   → 답: 표 "~3.4 ms historical; N-API is ~1.5 µs"(getting-started.md:852-858)와 각주 "The ~24/27µs for Node/Bun ..."(getting-started.md:860-862) — 24/27µs는 표 어디에도 없다. README.md:667-674의 현행 값(2.76ms/16.86µs/1.26µs/2.27µs)과도 다르다.
   → 결손: 근거 없는 수치 참조 + 문서 간 상이. wire-format.md:41-42가 자체적으로 정한 "수치를 인용할 때 레이어와 날짜를 밝혀라" 원칙 위반이기도 하다.
   → 제안: getting-started 요약표를 README 2026-08-24 표와 동일값+날짜로 통합하거나, 수치를 지우고 benchmarks.md 링크만 남긴다.

9. **[f/a] "Minimal Example" 절이 300줄짜리 types.ts 전체 덤프다.**
   → 답: getting-started.md:272-578(docs:sync 블록)은 calculator의 29개 커맨드 타입 전체(Bench*, Resource*, Channel*, RegistryDemo 등 본 가이드와 무관)를 싣고, 영어 문서 안에 한국어 JSDoc(예: 329-331, 341-347, 437-446, 565-570)가 그대로 노출된다.
   → 결손: 초심자 절의 정보 과부하 + 언어 누출. "어떻게 쓰는지" 학습에 필요한 것은 addNumbers 관련 타입뿐이다.
   → 제안: docs:sync 대상을 addNumbers 관련 발췌로 좁히거나(동기화 도구가 발췌를 지원하지 않으면 예제 전체는 부록/별도 파일로 이동), 최소한 한국어 주석 번역. §3 설명(getting-started.md:580-583)은 지금대로 유지.

10. **[a] init 없이 외부 프로젝트를 시작한다. Node 런타임이 구현해야 하는 stdio 계약의 코드는 어디 있나?**
    → 답: "The standard runtime must implement the one-shot stdio protocol ... `run_invoke_stdio` in the calculator and the `rustra init` scaffold is the reference implementation"(getting-started.md:679-686) — 코드는 문서에 없고 예제/init 템플릿으로 넘긴다.
    → 결손: 핵심 계약(이걸 못 하면 Node 경로가 아예 안 돌아감)의 실행 단계 부재.
    → 제안: §6 "Build Pipeline" 근처에 `__rustra_contract` 포함 최소 stdio main 표준 스니펫(~25줄, transport-guide.md:75-91을 일반화)을 인라인.

11. **[f] RN 설정의 `"positional": true`는 무엇인가?**
    → 답: getting-started.md:782에 키만 등장. 문서집 전체에서 설명이 없다(architecture.md가 "positional facade"라는 말을 한 번 사용, rust-api-guide.md:483).
    → 결손: 설정 키 미정의.
    → 제안: 한 문장 정의("생성 헬퍼를 필드-위치 인자 형태로 발행하는 옵션 — §commands.ts")를 인접 배치, 또는 rustra.json 스키마 가이드로 링크.

12. **[f] RN JSON 경로의 `customNativeTransport`는 어디서 오는가?**
    → 답: getting-started.md:836-844가 `import { customNativeTransport } from './native-transport'`를 사용하나 이 모듈 작성법을 다루는 문서가 없다.
    → 결손: 저수준 경로를 설명하면서 그 전제(커스텀 transport 작성)를 문서화하지 않음.
    → 제안: transport-guide.md로의 명시 링크("커스텀 transport 작성은 교체 가이드 §2-3")를 예제 아래 추가하거나, 해당 경로를 "고급 — 문서 링크"로 축소.

13. **[c] 전제 도구 버전을 한 곳에서 알 수 없다.**
    → 답: Bun≥1.4는 react-native-setup.md:68, MSRV 1.88은 versioning-policy.md:70-73과 development-hurdles.md:42, Node v22은 benchmarks.md:17(측정 환경 표)에만 있다. README/getting-started에는 요구사항 절이 없다.
    → 결손: 설치 절의 전제 조건 누락(유형 c).
    → 제안: getting-started §1 앞에 "전제 조건" 표(러스트 1.88+/Bun 1.4+/호스트별 플랫폼 도구) 5줄 추가.

### 4-3. docs/rust-api-guide.md / .ko.md

14. **[d] i64의 TS 매핑이 문서 간에 다르다.**
    → 답: rust-api-guide.md:580-582 "`i64`, `i32`, `u32`, `f64` 등 → `number`"(ko 575) vs getting-started.md:1082과 README.md:564 "`i64` → `number | bigint`". 같은 문서 내 §9 스칼라 절(rust-api-guide.md:649-669)은 `int64` widen을 인정한다.
    → 결손: 레퍼런스 표가 실제 코드젠(실측: examples/calculator/generated/types.ts의 `number | bigint`)과 불일치.
    → 제안: 표의 i64 행을 `number | bigint`(2^53 밖은 bigint)로 수정 — 나머지 정수는 `number`로 분리 행.

15. **[a] 이벤트 계약(`.event()`)을 레퍼런스에서 찾을 수 없다.**
    → 답: PackageBuilder 메서드 표(rust-api-guide.md:341-351)에 `.event()`가 없다. 존재 증거는 예제 소스 주석(examples/streaming/src/lib.rs:13)과 README 로드맵(README.md:53)뿐.
    → 결손: 코드젠까지 지원되는 공개 API의 레퍼런스 부재(유형 a/e).
    → 제안: 메서드 표에 `.event::<T>(name)` 행 추가 + 부록 "Event bus"(879-885)를 "이벤트 계약 작성 → 생성물 → JS subscribeEvent"의 완전한 흐름으로 확장하고 streaming 예제를 링크.

16. **[a] 계획된 진단 메시지가 레퍼런스 본문을 차지한다.**
    → 답: rust-api-guide.md:141-163은 `#[diagnostic::on_unimplemented]` 기반 커스텀 에러가 "planned but not implemented"임을 두 개의 가상 에러 출력과 함께 싣는다.
    → 결손: 없는 동작의 예상 출력은 독자가 실제 컴파일 에러와 혼동하게 한다(유형 a의 변형 — 실행 단계가 아니라 실행 불가 단계를 문서화).
    → 제안: "로드맵" 각주 1~2줄로 압축하고 실제 E0277 예시만 남김.

17. **[b] `buffer_command_fn`의 상세 계약이 내부 플랜 문서로 끝난다.**
    → 답: "For the detailed contract see the [direct byte-buffer design](plans/2026-08-24-rn-byte-buffer-native-path.md)"(rust-api-guide.md:337).
    → 결손: 사용자 API의 사양이 구현 계획서(내부 기록, docs/README.md:57-61이 정의하는 바)를 참조하게 됨.
    → 제안: 사용자에게 필요한 계약 요지(스키마 조건, 빌드 타임 패닉 조건, 메모리 소유)를 본문에 두고 플랜은 근거 링크로 강등.

18. **[f] `State<T>` 커맨드 파라미터가 코드에는 있고 문서에는 없다.**
    → 답: 매크로 오류문구 자체가 "at most one input data parameter (plus optional State<T> parameters)"(crates/rustra-macros/src/macro_command.rs:80)이며 `.manage(state)`가 표에는 있으나(rust-api-guide.md:351), `#[command] fn f(input: I, state: State<T>)` 형태의 파라미터 사용법을 문서가 다루지 않는다(문서 내 State< 는 Tauri 코드 인용뿐 — architecture.md:347).
    → 결손: 공개 시그니처 형태 미문서화(유형 f/a 경계).
    → 제안: §2에 "상태 주입: `State<T>` 추가 파라미터 + `.manage()`" 소절 추가(또는 의도적으로 비공개라면 명시).

### 4-4. docs/architecture.md / .ko.md

19. **[d] 데이터플로우 다이어그램이 존재하지 않는 빌더 메서드 `.register()`를 쓴다.**
    → 답: architecture.md:22-24 `Package::builder(...).register(add_numbers).build()`(ko 23). 실제 API는 `.command_fn`/`.command`(rust-api-guide.md:276-300).
    → 결손: 첫 다이어그램부터 복사하면 컴파일되지 않는 코드.
    → 제안: `.command_fn(add_numbers)`로 수정.

20. **[d] 전형 워크플로의 마지막 단계가 생성 헬퍼에 engine을 넘기는 것처럼 생겼다.**
    → 답: "4. Use the generated code ... `const result = await myCommand(engine, { ... })`"(architecture.md:524-527, ko 525). 생성 헬퍼는 input만 받는다(rust-api-guide.md:697, getting-started.md:588-603).
    → 결손: 결손 #7과 같은 뿌리의 모순이 아키텍처 문서에도 존재.
    → 제안: `myCommand(input)`과 "엔진은 호스트 엔트리가 configureLazy로 설치" 문장으로 교체.

21. **[d] `#[command]` 매크의 검증 규칙 서술이 사실과 다르다.**
    → 답: "at least one parameter" / "Auto-detects scalar parameter (two or more) vs struct (one)" / 반환 "Result<O>, a bare value, or ()"(architecture.md:164-166, 540-548). 실제로는 다중 파라미터가 컴파일 에러(rust-api-guide.md:29-34, crates/rustra-macros/src/macro_command.rs:80), bare 반환도 에러(rust-api-guide.md:80-85), 0-파라미터는 허용(rust-api-guide.md:64-77).
    → 결손: 두 문서가 매크로 계약을 다르게 기술 — rust-api-guide가 실측과 일치하므로 architecture가 스테일.
    → 제안: architecture §macros와 "Compile-Time Type Safety"를 rust-api-guide §2와 동일 사실로 재작성(또는 해당 절을 rust-api-guide로 링크로 대체).

22. **[d] 타입 변환 표와 "명명 타입 없음" 서술이 실제 생성물과 다르다.**
    → 답: "integer / number → number" 표와 "the whole schema tree is converted directly, without extracting separate named types"(architecture.md:255-264). 실측 생성물 types.ts는 명명 타입(`AddNumbersInput` 등)과 `number | bigint`를 발행한다(getting-started.md:272-578).
    → 결손: 아키텍처 문서의 코드젠 설명이 구현보다 오래됨.
    → 제안: 표에 i64 widen 반영, "명명 타입으로 발행" 사실로 문장 교체.

### 4-5. docs/compatibility-matrix.md

23. **[d] 매트릭스가 2개 중복 수록되어 서로 모순된다. (본 감사 최심 결손)**
    → 답: 첫 표(compatibility-matrix.md:9-19)는 Node/Bun/Tauri 채널 ✅(`createNodeChannel` 등), RN JSON 이벤트 ✅(pollMs). 두 번째 표(compatibility-matrix.md:21-30)는 채널 ❌("no transport channel source"), RN JSON 이벤트 ❌("JSON adapter"). 본문 산문(41-47행)과 README 로드맵(README.md:114-124, "no ❌ cells remain")은 첫 표와 일치하므로 **두 번째 표가 스테일**이다. ko 미러에는 표가 1개뿐(중복 없음)이므로 en 전용 결함이기도 하다.
    → 결손: "내 호스트에서 채널/이벤트가 되는가"라는 도입 의사결정 질문에 문서가 두 개의 반대 답을 준다. 셀 단위 상세(채널/이진 채널/이벤트 3행 × Node/Bun/Tauri/RN-JSON)가 통째로 갈린다.
    → 제안: 21-30행 표 삭제. 재발 방지를 위해 매트릭스 표에 "마지막 검증 날짜" 각주 추가.

24. **[c] "내 앱은 생성 엔트리를 쓰는데, 표의 어느 열이 나인가?"**
    → 답: 표 열은 `createNodeEngine` 등 엔진 팩토리 기준(compatibility-matrix.md:9)이지만, 기본 경로는 생성 호스트 엔트리다(getting-started.md:850-864). "generated node.ts는 어떤 열/어떤 시맨틱인가"의 대응이 표에 없다.
    → 결손: 기본 사용자와 표의 좌표계가 다름(유형 c).
    → 제안: 표 위에 "기본 생성 엔트리 ↔ 열" 대응 문장("Node/Bun/Tauri/RN 기본 엔트리 = JSON 엔진 열 단, RN 기본은 rkyv V2 열") 추가.

### 4-6. docs/extending/transport-guide.md

25. **[d] "Current Implementation Status" 표가 현행 기본 경로와 다르다.**
    → 답: Node/Bun의 현재 transport를 "subprocess stdio (spawnSync)"로 기술(transport-guide.md:38-43). 현행 기본은 Node 생성 원샷 바이너리+계약 검사(getting-started.md:679-687), Bun cdylib+안정 C ABI+rkyv V2(getting-started.md:704-723)다.
    → 결손: 교체 가이드의 출발점 설명이 스테일 — 독자는 "아, 기본이 spawnSync구나"라고 잘못 학습한다.
    → 제안: 표를 현행 기본(생성 엔트리 경로) 기준으로 갱신하고 subprocess/FFI는 "수동 조립 시 대안"으로 재명명.

26. **[d] Bun FFI 예제 전체가 제거된 심볼을 사용한다.**
    → 답: `rustra_calculator_invoke`/`rustra_calculator_free_string` 사용(transport-guide.md:99-142 RN 절, 259-299 Bun FFI 예제). 이 심볼은 2026-09-03 legacy removal로 제거되었다(benchmarks.md:223-227가 명시; 코드 잔존물은 `rustra_calculator_invoke_typed_raw`라는 다른 심볼뿐 — examples/calculator/tests/rkyv_v2_panic_guard.rs:179, 제거를 언급하는 테스트 주석 examples/calculator/ts/runtime-contract.test.ts:51).
    → 결손: 가이드의 핵심 예제(Bun FFI §4)가 그대로 따라 하면 빌드되지 않는 코드다. RN 절(93-142)도 동일 심볼 기준.
    → 제안: 코어 공개 FFI(`rustra_ffi_invoke_json` 등 — rust-api-guide.md:922-926 목록) 기준으로 예제 재작성, 또는 legacy 절로 명시적 격리.

27. **[b] napi 예제의 경로가 틀렸다.**
    → 답: `// crates/calculator-napi/src/lib.rs`(transport-guide.md:329). 실제 위치는 `examples/calculator-napi/`(자체 Cargo.toml 존재 실측).
    → 결손: 파일 위치 불명확(유형 b).
    → 제안: `examples/calculator-napi` 경로로 수정.

### 4-7. docs/development-hurdles.md, migration-guide.md, versioning-policy.md

28. **[a/e] "UI부터 만들고 싶다"는 약속의 실체가 없다.**
    → 답: README FAQ "use the mock engine from `@rustra/testing`. See the [development hurdles guide]"(README.md:139-141). 그러나 development-hurdles.md에는 `@rustra/testing`/mock engine 언급이 없다(grep 0건). `createMockEngine`의 사용법은 plans 문서에만 존재.
    → 결손: FAQ가 가리키는 문서가 그 내용을 담지 않음 — 링크는 있으나 도달 불가(유형 e) + 실행 단계 부재(a).
    → 제안: development-hurdles에 "Rust 없이 시작하기: createMockEngine" 절 추가하거나 FAQ 링크를 examples(auth/ts 테스트가 mock engine 사용)로 변경.

29. **[e] CI 통합 스니펫이 그대로는 실행 불가다.**
    → 답: migration-guide.md:118-125 — GitHub Actions에서 `rustra diff`를 실행하나 CLI 설치 단계도, 과거 스키마 아티팩트 준비도 없다.
    → 결손: 반쪽짜리 실행 단계.
    → 제안: `- run: bun i -g @rustra/cli`(또는 bunx 형태)와 `actions/checkout` fetch-depth 명시를 포함한 완전형으로 교체.

30. **[c] `rustra diff` 버전 주의가 없다.**
    → 답: diff는 스키마 형식에 의존하지만, 구버전 rustra(0.5 이전)가 만든 schema.json의 `inputType` 제네릭 표기 문제(rust-api-guide.md:626-629) 등 마이그레이션 창구 문서(migration-guide.md)와 버전 정책(versioning-policy.md:42-45, migrations 링크)가 상호 연결되지 않고 각자 서술한다.
    → 결손: "0.5→0.6/0.3→0.4 사용자는 diff 전에 무엇을 먼저 할 것인가" 분기 안내 부재.
    → 제안: migration-guide 상단에 "당신의 버전 → 해당 마이그레이션 노트" 순서 안내 3줄 추가.

### 4-8. 색인/구조 (docs/README.md)

31. **[e] 문서 색인이 불완전하다.**
    → 답: docs/README.md:28-51 표에 wire-format.md, verification-checklist.md, migrations/ 디렉터리가 없고(각각 README.md:33, README.md:655-658, versioning-policy.md:42-45 에서만 언급), **examples/ 디렉터리 전체가 색인에 0회 언급**된다(grep 실측).
    → 결손: 좋은 문서/예제로 가는 진입점 누락.
    → 제안: 표에 3문서 추가 + "예제 갤러리" 절에서 10개 예제(calculator/crud/streaming/auth/tauri-calculator/react-native-calculator/react-native-bare-calculator/calculator-napi/benchmark/reference-app)를 각각 "무엇을 배우는지 1줄"과 함께 나열.

32. **[d] CHANGELOG가 한국어 단일판이다.**
    → 답: CHANGELOG.md는 한국어 본문("이 프로젝트의 주요 변경사항을 기록합니다")이고 영문판이 없다 — 다른 모든 문서가 en/ko 미러인 집합의 예외.
    → 결손: 영어 사용자의 버전 이력 접근 불가(유형 d의 언어 미러 붕괴).
    → 제안: CHANGELOG.en.md 추가 또는 최소한 상단에 영어 요약 링크.

33. **[c] getting-started의 표 형식 파솄 및 용어 혼용(경미).**
    → 답: 요약표 RN 행이 백틱 없이 `generated react-native.ts`로만 표기(getting-started.md:855), 문서 제목은 `rustra-bridge`(rust-api-guide.md:3, architecture.md:3)와 `rustra`(README.md:3)가 혼용.
    → 결손: 검색/일관성 마찰.
    → 제안: 표기 통일 + "rustra = 크레이트, rustra-bridge = 저장소" 용어 각주 1줄(또는 통일).

---

## 5. 구조 제안

### 5-1. 개선 우선순위 Top 10

| # | 개선안 | 형태 | 근거(결손 번호) |
| --- | --- | --- | --- |
| 1 | compatibility-matrix.md 스테일 2차 표(21-30행) 삭제 + "기본 생성 엔트리 ↔ 열" 대응 문장 추가 | 재작성(삭제) | #23, #24 |
| 2 | 설치 버전 단일화: `rustra = "0.6"`줄 갱신, "발행 시 갱신" TODO 6곳 제거, 검증 조합(0.8.x) 문장 통일 | 재작성 | #1 |
| 3 | getting-started 자기모순 수정: 요약 다이어그램의 configure() 제거(§4와 정렬), 24/27µs 각주·성능표 README 실표와 통합 | 재작성 | #7, #8 |
| 4 | rust-api-guide 타입 매핑 표 i64 → `number \| bigint` 수정(architecture 표 포함) | 수정 | #14, #22 |
| 5 | transport-guide 현행화: 상태표를 생성 엔트리 기준으로, 제거된 `rustra_calculator_*` 예제를 코어 `rustra_ffi_*`로 재작성, napi 경로 수정 | 재작성+예제 교체 | #25, #26, #27 |
| 6 | "기존 Tauri 앱에 rustra 얹기" 단일 워크스루 신설(getting-started §Tauri 확장 또는 docs/extending/tauri-setup.md): 변경 파일 5개(Cargo.toml/src-tauri/main.rs/tauri.conf.json/rustra.json/프런트 import)를 순서대로, withGlobalTauri 실제 JSON 포함 | 새 절 | P2 여정, #20 결손 아님(신규), getting-started.md:725-753 참조 |
| 7 | 이벤트/채널 사용법 통합: `.event()`를 빌더 표에 추가 + "이벤트&채널 가이드"(Rust 선언 → 생성물 → JS subscribeEvent/unsubscribe, streaming 예제 연결) | 새 절+레퍼런스 보강 | #15, #4 |
| 8 | getting-started §3 types.ts 전체 덤프 축소(addNumbers 발췌 + 부록 이동), 한국어 JSDoc 잔여 정리 | 재구성 | #9 |
| 9 | "첫 rustra.json + 표준 stdio 런타임" 인라인化: 외부 프로젝트용 rustra.json 최소형과 `__rustra_contract` 포함 stdio main 스니펫을 메인 경로에 배치 | 예제 추가 | #2, #10 |
| 10 | 색인 완성: docs/README.md에 wire-format/verification-checklist/migrations + 예제 갤러리 추가, CLI 실행 표준형 정리, mock engine(@rustra/testing)·React hooks 사용 가이드 또는 링크 | 색인 재구성+새 가이드 | #31, #6, #28, #5 |

### 5-2. "사용법 중심 재구성" 목차 제안

현재 docs/README.md의 읽기 경로(docs/README.md:9-17)는 "개념 → 튜토리얼 → 레퍼런스" 순의 지식 조직이다. 문제 진술("내 상황에서 무엇을")에 맞추려면 **상황(호스트/역할)이 1차, 지식이 2차**인 구조로 바꾼다.

```
docs/
  README.md                    # 역할별 3열 진입 (앱 개발자/라이브러리 작성자/기여자) + 예제 갤러리
  what-is-rustra.md            # 5분 평가: 하는 일/안 하는 일/비교표/성능 (P4; README 콘텐츠 흡수)
  requirements.md              # 전제 도구 매트릭스(러스트 1.88+/Bun 1.4+/호스트별) — #13
  quickstart/
    react-native.md            # P1: init 또는 기존 앱 → doctor → codegen → 첫 호출 → 트러블슈팅
    tauri.md                   # P2: 기존 Tauri 앱 파일별 워크스루 (신규)
    node-bun.md                # 서비스/CLI 경로
    library-author.md          # P3: 명령 작성 → rustra.json → schema → codegen → JS 팀 전달/배포
  reference/
    rust-api.md                # 현행 rust-api-guide (`.event()`/`State<T>` 보강 — #15, #18)
    rustra-json.md             # 설정 키 전체(`positional` 등 정의 포함 — #11)
    cli.md                     # init/doctor/codegen/dev/diff/generate 표준 실행형 포함 — #6
    type-mapping.md            # 매핑 단일 진실(#14 해소), complex-codecs/wire-format 흡수 또는 링크
  guides/
    events-and-channels.md     # 신규 — #15/#4
    errors-and-semantics.md    # 에러 코드/재시도/취소·타임아웃·배치 호출 예제 — #4
    testing.md                 # createMockEngine + @rustra/testing — #28
    react-hooks.md             # @rustra/react — #5
  compatibility/               # matrix(단일 표)/contract/migrations/versioning — 현행 유지+정리
  internals/                   # architecture/codegen/testing/crate-structure (기여자)
  extending/                   # react-native-setup(현행 유지)/transport-guide(현행화 후)/adding-host
```

이 중 당장 비용 대비 효과가 가장 큰 것은 신규 디렉터리 재편이 아니라 **Top 10의 1~5(모순 제거)**이다. 구조 재편은 모순이 제거된 뒤 2단계로 권한다.

---

## 6. 부록 — 실측 근거 요약

- 버전 실측: `Cargo.toml`(root) `version = "0.8.0"`, `packages/types/package.json` `"version": "0.8.0"` vs 문서 설치줄 `rustra = "0.6"`(README.md:166 등 4파일 6곳, TODO 주석 포함).
- 매크로 규칙 실측: `crates/rustra-macros/src/macro_command.rs:80`("at most one input data parameter (plus optional State<T> parameters)"), `crates/rustra-macros/src/macro_build.rs:72`(`__RUstra_meta_` 네이밍 — rust-api-guide.md:258 서술과 일치).
- legacy 심볼 실측: `rustra_calculator_invoke`(문자열 그대로)는 예제 테스트 주석의 "제거 후" 언급과 `rustra_calculator_invoke_typed_raw`(별개 심볼)만 남음(examples/calculator/tests/rkyv_v2_panic_guard.rs:179, examples/calculator/ts/runtime-contract.test.ts:51).
- ko 미러 실측: compatibility-matrix.ko.md는 표 1개(EN의 2번째 스테일 표 없음). rust-api-guide.ko.md:575(i64→number), getting-started.ko.md:1126(configure 요약), architecture.ko.md:23/525는 EN과 동일 결손.
- 문서-예제 연결 실측: docs/README.md에서 `examples` grep 0건. examples/ 하위 10개 디렉터리 전부 README.md/README.ko.md 보유(react-native-calculator, calculator, calculator-napi, auth, tauri-calculator, streaming, crud, benchmark, react-native-bare-calculator, reference-app).
- invokeBatch 호출 예제 grep 0건(docs+README en). `@rustra/testing`/mock engine, getting-started·development-hurdles grep 0건.

[English](./dev-tier.md)

# 동적 개발 티어 (Dev Tier)

rustra의 계약은 릴리스 시점에 얼어붙는다 — schema.json, 생성 클라이언트, 디바이스
토큰 카탈로그 전부 닫힌 집합이다. **개발 중에는 그 벽을 열어도 된다.** 이 문서는
"개발 중 동적 / 릴리스 정적"을 지탱하는 4가지 장치와, 동적으로 실험한 것을 정적
계약으로 승격하는 시점을 다룬다.

| 장치                                                                    | 개발 중                        | 릴리스 벽                                                           |
| ----------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| [`invokeLoose`](#invokeloose-커맨드-프로토타이핑) — 이름 기반 즉석 호출 | 어떤 커맨드든 문자열 키로 호출 | 고빈도 명령은 `rustra codegen`으로 정적 승격 권장(Tier 3 JSON 비용) |
| 런타임 커맨드 등록 — `Package::register` (debug 빌드)                   | Rust 핸들러를 즉석 등록        | release 빌드는 freeze — 선언 기반 재작성                            |
| [디바이스 토큰 실험](#디바이스-토큰-실험) — 카탈로그 밖 토큰            | debug 빌드는 경고 후 수용      | release 빌드는 등록 시점 패닉 + `rustra doctor` fail 검사 (이중 벽) |
| [`test:fast`](#게이트-프로파일) — 빠른 검증 루프                        | 컴파일 정합 + 코드젠 유닛      | 풀 배터리는 CI/PR 그대로                                            |

## invokeLoose 커맨드 프로토타이핑

생성 클라이언트(`commands.ts`의 타입화 함수)를 기다리지 않고 커맨드를 이름으로
호출하는 공식 표면이다. 새 매커니즘이 아니라 엔진의 이름 기반 `invoke`에 명명된
진입점을 준 것 — 엔진이 정적 코덱 fast-path → live schema commandId 조회 →
Tier 3(JSON) 폴백 체인을 이미 판정한다.

```ts
import { invokeLoose } from '@rustra/types';

// 반환 타입 기본값은 unknown — 호출자가 좁힌다.
const info = await invokeLoose<{ os: string }>(engine, 'platformNativeInfo');
```

프로토타이핑 루프:

1. **Rust 핸들러 추가** — 매크로(`#[command]`) 또는 debug 빌드의 런타임 등록
   (`Package::register`, 문자열 키).
2. **`cargo build`** — 이게 Rust 쪽 전부다.
3. **JS에서 곧장 `invokeLoose(engine, 'myCommand', args)`** — 코드젠·tsc·
   api-surface 갱신이 필요 없다. live schema가 commandId를 제공하고, 레지스트리에
   코덱이 없으면 Tier 3 JSON 경로로 동작한다.

정적 승격 시점 — 커맨드의 입력·출력 타입이 안정되고 호출 빈도가 올라가면 평소처럼
`rustra codegen`을 돌려 타입화 클라이언트로 옮긴다. Tier 3 JSON 폴백은 JSON
직렬화 비용을 지불하므로 고빈도·대용량 페이로드 명령은 정적 경로가 맞다(비용 근거는
[벤치마크](benchmarks.md) 참조).

## 디바이스 토큰 실험

디바이스 역량 카탈로그(`DeviceCapability::ALL` 21종)는 버전닝된 닫힌 집합이다.
새 토큰이 rustra 릴리스로 들어오기 전에 실험하려면:

1. **debug 빌드에서 선언** — `#[command(device("nfc-legacy-reader"))]`처럼 카탈로그
   밖 토큰을 쓰면 debug 빌드는 경고를 인쇄하고 수용한다. 선언은 schema.json
   `devices`로 흐른다.
2. **코드젠은 마커와 함께 렌더** — 생성 `devices.ts`의 유니언·상수에 미지 토큰이
   포함되고, 유니언 아래에 "카탈로그 밖 토큰" 마커 주석이 붙는다.
3. **릴리스 벽 2중** — `rustra doctor`의 `codegen.device_catalog` 검사가 미지
   토큰을 **fail**로 보고하고, release 빌드는 등록 시점에 패닉한다. 릴리스하려면
   카탈로그 토큰으로 교체하거나 rustra 카탈로그 확장 릴리스를 기다린다
   ([플랫폼 권한 교차표](platform-permissions.md) 갱신 동반).

카탈로그 자체는 schema.json 최상위 `deviceCapabilities`로 단일소싱된다 — CLI는
이 필드를 읽어 정렬·검증하므로 수동 미러는 존재하지 않는다.

## 게이트 프로파일

| 시점      | 무엇을 돌리나                           | 커맨드                            |
| --------- | --------------------------------------- | --------------------------------- |
| 개발 루프 | cargo check + calculator tsc + cli 유닛 | `bun run test:fast`               |
| 커밋      | eslint/prettier/rustfmt (staged만)      | lefthook pre-commit 자동          |
| PR/CI     | 풀 배터리 10잡 + docs·codegen 체크      | `scripts/ci-gate.sh`              |
| 발행      | release-coherence·패키지 검증·changeset | [발행 절차](release-procedure.md) |

Rust 동작 검증은 개발 중 `cargo test -p rustra <필터>`로 필요한 만큼만 ad-hoc로
돌린다. 드리프트(코드젠 체크·docs 리전)는 풀 배터리가 잡는다 — 개발 루프에서
의례를 반복할 이유가 없다.

## 범위 밖

- **`rustra codegen --from-live`** — live 레지스트리 덤프에서 `#[command]` 골격을
  뽑아주는 승격 스캐폴딩은 후속 슬라이스다(설계:
  [dev-tier 설계](plans/2026-09-08-dev-tier-design.md) G절).
- **RN 번들 서브셋**(`registry.commands`) — 같은 Tier 3 방향의 별개 트랙
  ([A13 설계](plans/2026-09-08-a13-rn-registry-subset-design.md) 참조).

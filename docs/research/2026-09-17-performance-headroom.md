---
date: 2026-09-17
researcher: codex
git_commit: 7d54280dbde25f9bd0a2c1d41e86e3ea2af22b02
topic: '공개 호출 경로의 잔여 성능 여유 계측 — 2배 목표의 물리적 근거 판정'
status: research-complete
---

# 공개 호출 경로에 2배의 여유가 남아 있는가

**결론: 현재 Frame wire·소유형 API 계약 안에서 전면 2배는 계측 구조상 성립 근거가 없다.** 소형 호출은 이미 46–55 ns의 바닥에 있고, 대형 페이로드는 memcpy 대역폭(측정 12.6 GB/s)에 닿아 있으며, 최대 작업부하의 프로파일은 단일 제거 가능 항목 없이 평평하다. 이 결론은 0.10.2(#73)가 직렬화 직결 경로로 가져간 큰 배수 뒤에 남은 비용 지형을 기준으로 한다. 2배가 실제로 가능한 레버는 와이어 포맷 v3(파괴적), zero-copy 디코드(API 파괴적), 그리고 [측정만 남은 PropNameID 재사용 A/B](2026-09-16-nitro-call-profile.md)다. 아래 수치는 모두 이 문서 작성 시점의 로컬 M 시리즈(macOS, release bench) 실측이다.

## 방법

1. 기준선: `cargo bench -p rustra --bench {complex_route,function_dispatch,tree_route} -- --save-baseline pre-perf` (criterion 500 샘플, 로컬). 비교는 `--baseline pre-perf`로 재현한다.
2. 프로파일: `sample`(macOS) 8초 채집 — 벤치 바이너리는 `CARGO_PROFILE_BENCH_DEBUG=2`로 심볼을 심어 사용한다(스트립 바이너리는 모든 프레임이 `start (dyld)`로 붕괴되어 판독 불가).
3. 할당: `cargo run -p rustra --release --example codec_allocations` (호출당 alloc 카운트).

## 기준선 (요약)

| 작업부하                      |         시간 | 비고                                                      |
| ----------------------------- | -----------: | --------------------------------------------------------- |
| function frame / json         |   46 / 50 ns | FFI·JSON 디스패치 바닥 (legacy json 322 ns 대비 이미 6배) |
| complex scalar_control        |        55 ns | 레지스트리+프레임 오버헤드 바닥                           |
| complex optional_none / oneof | 134 / 154 ns |                                                           |
| wide_struct_32                |      1.44 µs | 필드당 ~45 ns                                             |
| map_keys_64                   |      15.8 µs | 키당 ~250 ns, **호출당 151회 할당**                       |
| map_seq_1024 / map_keys_64급  |      15.6 µs |                                                           |
| optional_string_64k           |      5.07 µs | 12.8 GB/s — memcpy 대역폭                                 |
| optional_chunks_near_1m       |      78.2 µs | 12.6 GB/s — 대역폭 한계                                   |
| tree echo balanced1023        |       930 µs | 노드당 ~0.9 µs (decode+encode 왕복)                       |
| tree search balanced1023      |       550 µs |                                                           |
| tree resident / dfs           |  122 / 66 ns | 앱 코드 지배 (기존 수화물과 일치)                         |

## 프로파일 소비 구조

**map_keys_64 (15.8 µs = 6,408 샘플).** 디코드 측 58% — `deserialize_struct → visit_map → BTreeMap deserialize → insert`가 지배하며 그중 키 비교 `memcmp`가 856 샘플(13%), BTree 노드 삽입 기계·할당이 뒤를 잇는다. 인코딩 측 ~39% — 엔트리별 `MapBytes` 스크래치 직렬화·정렬·출력 복사. 할당 151회/호출의 내역은 키 `String` 64 + 값 `Vec<u8>` 64 + BTree 노드 + 인코딩 스필이다. **전부 사용자가 선택한 소유형 타입(`BTreeMap<String, Vec<u8>>`)의 소유 비용**이며, serde 소유 계약을 깨지 않으면 제거할 수 없다.

**tree echo balanced1023 (930 µs).** 리프 분포가 평평하다 — `Writer::push` 계열 ~3.4%, memmove/memcpy ~2.6%, `Reader::varint/length` ~1.5%, malloc/free 계열 ~3.4%, `from_utf8` 0.4%, `peel_ser/peel` ~1.9%. 단일 10% 조각이 없다. 남은 비용은 노드별 varint 태그·바이트 push·소유 할당, 즉 와이어 포맷 자체의 구조적 비용이다.

## 배척·보류한 후보 (이번 계측에서)

- **응답 writer 사전 예약** — 상한이 성장 복사 전체(memmove+memcpy+push ≈ 6%)이고, 입력 길이를 힌트로 쓰면 비대칭 핸들러(입력 1 MB·출력 16 B)에서 과대 예약 메모리가 반환 Vec에 그대로 남는다. 기대 2–6% vs 메모리 계약 위험 — 채택하지 않음.
- **맵 인코딩 스트리밍(단일 엔트리 룩어헤드로 정렬 생략)** — 인코딩 측의 일부(전체의 ~10%)만 절감 가능하고 소스가 `HashMap`이면 재정렬이 필요해 계속 스크래치를 유지해야 한다. 복잡도 대비 보류.
- **wire 변경·zero-copy 디코드** — 공개 계약(`docs/compatibility-contract.md`, Frame wire) 위반이다. 2배의 실질 출처는 여기에 있으며 별도 메이저 트랙으로만 가능하다.

기존 트랙에서도 동일 결론의 선례가 있다: bounded-heap postcard(10–17% 느림, [거부 수화물](../benchmark-receipts/2026-09-16-nitro-postcard-rejected.json)), JS 클로저 병합(재설정 후 호출 +1, 폐기).

## 2배가 가능한 레버와 예상 근거

1. **PropNameID 재사용 A/B 완주 (측정만 남음)** — [계획된 AB/BA 5쌍 측정](2026-09-16-nitro-call-profile.md)을 실행해 채택 판정을 기록한다. 프로파일상 소형 호출 CPU의 ~5–6%가 고정 이름 생성이므로 기대치는 2배가 아닌 몇 %대다.
2. **wire v3 (파괴적)** — 노드별 태그·varint 밀도를 낮추는 배치 인코딩. tree류 작업부하에서 배수 가능성이 유일하게 열려 있는 경로. Frame 호환 계약과 함께 메이저 버전 트랙으로만 검토.
3. **zero-copy 디코드 (API 파괴적)** — 빌린 키/값 뷰를 허용하는 별도 디스패치 표면. 맵 계열 할당의 대부분이 사라진다.

## 재현

```sh
cargo bench -p rustra --bench complex_route -- --save-baseline <name>
CARGO_PROFILE_BENCH_DEBUG=2 cargo bench -p rustra --bench complex_route --no-run
target/release/deps/complex_route-* --bench invoke_frame/map_keys_64 \
  --sample-size 100 --measurement-time 40 --warm-up-time 2 &   # sample <name> 8 -file out.txt
cargo run -p rustra --release --example codec_allocations
```

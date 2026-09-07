# 플랫폼 상호운용 후속 슬라이스 + 경쟁 격차 안정화 (2026-09-07)

설계: `2026-09-07-platform-interop-stabilization-design.md` (남는 일 섹션)
비교 근거: `docs/research/2026-09-07-competitive-landscape.md`

- [x] Task 1 — `#[command(platform(...))]` 매크로 속성: attr 파서 `platform` 키,
      cfg 배타적 진짜 inner/자동 스텁, `__RUstra_platforms_{fn}` 메타 상수,
      register!/build! 체인 `.platform_meta_if` 자동 연결, `platform_meta_if`
      빌더 메서드. 계산기 예제를 매크로 폼으로 전환 + 스텁 경로 회귀 테스트.
- [x] Task 2 — 채널 바이너리 페이로드: `ChannelBytesSender`,
      `ChannelHost::register_channel_bytes(_with_handle)/send_bytes`, drop 양쪽
      정리, `ChannelHandle::send_bytes`, FFI `rustra_ffi_channel_create_bytes`/
      `rustra_ffi_channel_send_bytes`(+bytes sink quiescence, guard 일반화로
      transmute 제거), C++ `ChannelDispatcher::createBytes/onChannelPayloadBytes` + `createChannelBytes` HostFunction, JS `createBytesChannel` + 테스트.
- [x] Task 3 — folly::dynamic: `RustraTurboInterop.hpp` +
      `invokeTypedByNameDynamic/ByIdDynamic`(dynamicToValue 변환기 포함).
- [x] Task 4 — 경쟁 격차 안정화 1차: RN 동기 호출 `invokeTypedSync`
      (Nitro 대비 Promise 오버헤드 제거; `sync.unavailable` 에러 코드 등록).
- [x] Task 5 — 문서: 경쟁 비교 리서치 문서, 설계 문서 남는 일 갱신, RN 셋업
      가이드 상호운용 절 보강(바이너리 채널·dynamic·동기 invoke).
- [ ] Task 6 — changeset — **사용자 지시로 제외**.

권장 다음 트랙(이번 범위 밖): 커맨드별 타입화 에러 코드젠(격차 #2, 성비 최고),
역방향 콜백(격차 #4, 채널 인프라 재사용), WASM 호스트(격차 #1, 별도 설계 필요).

## 성능 A/B 검증 (2026-09-07)

기준점 `88701491`(플랫폼 작업 직전) vs `89f1ce97`(패리티 완료) — 동일 머신,
교차(interleaved) 반복, trimmed-mean 수령증 중앙값:

| 케이스                                    | base µs | cur µs  | delta | n   |
| ----------------------------------------- | ------- | ------- | ----- | --- |
| node-persistent-loop (Read 인터셉터 경과) | 15.13   | 15.00   | -0.8% | 5   |
| node-napi-rkyv-v2                         | 2.93    | 2.91    | -0.5% | 7   |
| bun-generated-ffi-rkyv-v2                 | 6.04    | 6.05    | +0.2% | 5   |
| node-generated-one-shot (spawn 지배)      | 2692.97 | 2720.66 | +1.0% | 5   |

전 케이스 범위(min~max)가 겹친다 — **회귀 없음**. 정적 검토에서 발견한
이벤트 핫패스의 per-event `Array.from` 할당은 `Set.forEach`로 교체(무할당).
loop-stdio 인터셉터의 프레임당 추가 alloc+copy(수십 ns)는 측정 한계 이하로
확인되어 그대로 둔다.
